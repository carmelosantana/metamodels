import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { readCredentials, writeCredentials, type StoredCredential } from '../src/credentials.js'
import { refresh, SignInAgainError } from '../src/device.js'
import { loadCredential, refreshStored, type SessionContext } from '../src/session.js'
import { serveDiscovery, startStub, type Stub } from './helpers/stub.js'

const RESOURCE = 'http://console.test/api/admin'
let stub: Stub | undefined
afterEach(async () => {
  await stub?.close()
  stub = undefined
})

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'mm-cli-')), 'metamodels', 'credentials.json')
}

function stale(issuer: string): StoredCredential {
  return {
    issuer, resource: RESOURCE, scope: 'read', accessToken: 'at-1', accessExpiresAt: 0, refreshToken: 'rt-1', obtainedAt: 0,
  }
}

/**
 * A rotating OP: rt-1 is good exactly once and yields at-2/rt-2; anything presented after that is a
 * reuse and refused. The first refresh response is held until `release()`, so a second refresher
 * can be made to arrive while the first is still in flight.
 */
async function rotatingOp() {
  stub = await startStub()
  serveDiscovery(stub)
  const spent = new Set<string>()
  let release!: () => void
  const held = new Promise<void>((r) => { release = r })
  let arrived!: () => void
  const firstArrived = new Promise<void>((r) => { arrived = r })
  stub.on('POST /token', async (req) => {
    arrived()
    const presented = req.form.refresh_token
    if (spent.has(presented) || presented !== 'rt-1') {
      return { status: 400, json: { error: 'invalid_grant', error_description: 'grant request is invalid' } }
    }
    spent.add(presented)
    await held
    return { status: 200, json: { access_token: 'at-2', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt-2', scope: 'read' } }
  })
  const tokenRequests = () => stub!.requests.filter((r) => r.path === '/token').length
  return { op: stub, release, firstArrived, tokenRequests }
}

describe('refreshStored', () => {
  test('two concurrent refreshes of the same token send exactly one refresh request', async () => {
    const { op, release, firstArrived, tokenRequests } = await rotatingOp()
    const path = tempPath()
    writeCredentials(path, stale(op.url))
    const ctx: SessionContext = { path, issuer: op.url, resource: RESOURCE }

    const first = refreshStored(ctx, stale(op.url))
    await firstArrived
    // The second starts while the first holds the lock with its refresh in flight...
    let waited = 0
    let noticed!: () => void
    const blocked = new Promise<void>((r) => { noticed = r })
    const second = refreshStored({ ...ctx, lock: { pollMs: 5, onWait: () => { waited++; noticed() } } }, stale(op.url))
    await blocked
    expect(waited).toBeGreaterThan(0)
    release()

    const [a, b] = await Promise.all([first, second])
    // ...and, finding the store already refreshed once it gets the lock, uses that instead.
    expect(tokenRequests()).toBe(1)
    expect(a.accessToken).toBe('at-2')
    expect(b.accessToken).toBe('at-2')
    expect(readCredentials(path, op.url)).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-2' })
    expect(readdirSync(join(path, '..'))).toEqual(['credentials.json'])
  })

  test('the same two refreshes WITHOUT the lock send two requests, and the second is refused as a reuse', async () => {
    // The control for the test above: this stub really does punish a double refresh.
    const { op, release, firstArrived, tokenRequests } = await rotatingOp()
    const first = refresh({ issuer: op.url, resource: RESOURCE, refreshToken: 'rt-1' })
    await firstArrived
    const second = refresh({ issuer: op.url, resource: RESOURCE, refreshToken: 'rt-1' }).catch((e: unknown) => e)
    await expect(second).resolves.toBeInstanceOf(SignInAgainError)
    release()
    expect((await first).accessToken).toBe('at-2')
    expect(tokenRequests()).toBe(2)
  })

  test('stores the rotated refresh token', async () => {
    const { op, release } = await rotatingOp()
    release()
    const path = tempPath()
    writeCredentials(path, stale(op.url))
    await refreshStored({ path, issuer: op.url, resource: RESOURCE }, stale(op.url))
    expect(readCredentials(path, op.url)!.refreshToken).toBe('rt-2')
  })

  test('a refused refresh drops the stored credential — its token is spent — and says to sign in again', async () => {
    const { op, release, tokenRequests } = await rotatingOp()
    release()
    const path = tempPath()
    writeCredentials(path, { ...stale(op.url), refreshToken: 'rt-unknown' })
    const err = await refreshStored({ path, issuer: op.url, resource: RESOURCE }, stale(op.url)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SignInAgainError)
    expect(tokenRequests()).toBe(1)
    expect(readCredentials(path, op.url)).toBeNull()
  })

  test('a 5xx keeps the stored credential: the OP may never have seen the token', async () => {
    stub = await startStub()
    serveDiscovery(stub)
    stub.on('POST /token', () => ({ status: 502, json: {} }))
    const path = tempPath()
    writeCredentials(path, stale(stub.url))
    const err = await refreshStored({ path, issuer: stub.url, resource: RESOURCE }, stale(stub.url)).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(SignInAgainError)
    expect(readCredentials(path, stub.url)!.refreshToken).toBe('rt-1')
  })

  test('with no refresh token stored, it is "sign in again" and nothing is sent', async () => {
    const { op, release, tokenRequests } = await rotatingOp()
    release()
    const path = tempPath()
    const { refreshToken: _, ...noRefresh } = stale(op.url)
    writeCredentials(path, noRefresh)
    await expect(refreshStored({ path, issuer: op.url, resource: RESOURCE }, noRefresh)).rejects.toBeInstanceOf(SignInAgainError)
    expect(tokenRequests()).toBe(0)
  })
})

describe('loadCredential', () => {
  test('returns the stored credential for this issuer and resource', () => {
    const path = tempPath()
    writeCredentials(path, stale('http://op.test'))
    expect(loadCredential({ path, issuer: 'http://op.test', resource: RESOURCE }).accessToken).toBe('at-1')
  })

  test('refuses one bound to a different console, before anything is sent with it', () => {
    const path = tempPath()
    writeCredentials(path, stale('http://op.test'))
    expect(() => loadCredential({ path, issuer: 'http://op.test', resource: 'http://other.test/api/admin' }))
      .toThrow(/http:\/\/console\.test\/api\/admin/)
  })

  test('says to sign in when there is nothing stored', () => {
    expect(() => loadCredential({ path: tempPath(), issuer: 'http://op.test', resource: RESOURCE })).toThrow(/mm login/)
  })
})
