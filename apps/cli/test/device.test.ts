import { afterEach, describe, expect, test } from 'vitest'
import { CLI_CLIENT_ID } from '@metamodels/schema'
import { deviceLogin, discover, refresh, revokeRefreshToken, SignInAgainError, type OpDeps } from '../src/device.js'
import { serveDiscovery, startStub, type Reply, type Stub } from './helpers/stub.js'

const RESOURCE = 'http://console.test/api/admin'
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
let stub: Stub | undefined
afterEach(async () => {
  await stub?.close()
  stub = undefined
})

/** Deps that never really sleep: every requested wait is recorded instead. */
function fakeDeps(): OpDeps & { sleeps: number[]; printed: string[] } {
  let clock = 1_000_000
  const sleeps: number[] = []
  const printed: string[] = []
  return {
    sleeps,
    printed,
    now: () => clock,
    sleep: async (ms: number) => { sleeps.push(ms); clock += ms },
    print: (line: string) => { printed.push(line) },
  }
}

const TOKEN = { access_token: 'at-1', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt-1', scope: 'read resource.write' }

/** Discovery, device authorization, and a token endpoint answering `polls` in turn. */
async function stubOp(polls: Reply[], device: Record<string, unknown> = {}): Promise<Stub> {
  stub = await startStub()
  serveDiscovery(stub)
  stub.on('POST /device/auth', () => ({
    status: 200,
    json: {
      device_code: 'dc-1',
      user_code: 'BCDF-GHJK',
      verification_uri: `${stub!.url}/device`,
      verification_uri_complete: `${stub!.url}/device?user_code=BCDF-GHJK`,
      expires_in: 600,
      interval: 3,
      ...device,
    },
  }))
  let i = 0
  stub.on('POST /token', () => polls[Math.min(i++, polls.length - 1)])
  return stub
}

const pending: Reply = { status: 400, json: { error: 'authorization_pending' } }
const granted: Reply = { status: 200, json: TOKEN }

describe('deviceLogin', () => {
  test('asks for the admin resource, polls at the advertised interval, and returns the tokens', async () => {
    const op = await stubOp([pending, pending, granted])
    const deps = fakeDeps()
    const cred = await deviceLogin({ issuer: op.url, resource: RESOURCE, scopes: ['read', 'resource.write'] }, deps)

    const auth = op.requests.find((r) => r.path === '/device/auth')!
    expect(auth.form).toEqual({ client_id: CLI_CLIENT_ID, scope: 'openid offline_access read resource.write', resource: RESOURCE })
    // The confirm page shows the requesting machine's user agent: make it say what it is.
    expect(auth.headers['user-agent']).toMatch(/^metamodels-cli \(/)

    const polls = op.requests.filter((r) => r.path === '/token')
    expect(polls).toHaveLength(3)
    for (const p of polls) {
      expect(p.form).toEqual({ grant_type: DEVICE_GRANT, device_code: 'dc-1', client_id: CLI_CLIENT_ID, resource: RESOURCE })
    }
    expect(deps.sleeps).toEqual([3000, 3000, 3000])

    expect(cred).toEqual({
      issuer: op.url, resource: RESOURCE, scope: 'read resource.write', accessToken: 'at-1', refreshToken: 'rt-1',
      obtainedAt: 1_009_000, accessExpiresAt: 1_009_000 + 3_600_000,
    })
  })

  test('tells the operator where to go, that it asks for their password, and to cancel if the machine is not theirs', async () => {
    const op = await stubOp([granted])
    const deps = fakeDeps()
    await deviceLogin({ issuer: op.url, resource: RESOURCE, scopes: ['read'] }, deps)
    const text = deps.printed.join('\n')
    expect(text).toContain(`${op.url}/device?user_code=BCDF-GHJK`)
    expect(text).toContain('BCDF-GHJK')
    expect(text).toMatch(/password/)
    expect(text).toMatch(/IP address and user agent/)
    expect(text).toMatch(/Cancel/)
    expect(text).not.toContain('at-1')
    expect(text).not.toContain('rt-1')
  })

  test('without verification_uri_complete, prints the entry page and the code to type', async () => {
    const op = await stubOp([granted], { verification_uri_complete: undefined })
    const deps = fakeDeps()
    await deviceLogin({ issuer: op.url, resource: RESOURCE, scopes: ['read'] }, deps)
    const text = deps.printed.join('\n')
    expect(text).toContain(`${op.url}/device`)
    expect(text).not.toContain('user_code=')
    expect(text).toMatch(/enter the code\s+BCDF-GHJK/)
  })

  test('slow_down adds five seconds to the interval, for every later poll (RFC 8628 §3.5)', async () => {
    const op = await stubOp([{ status: 400, json: { error: 'slow_down' } }, pending, granted], { interval: 5 })
    const deps = fakeDeps()
    await deviceLogin({ issuer: op.url, resource: RESOURCE, scopes: ['read'] }, deps)
    expect(deps.sleeps).toEqual([5000, 10000, 10000])
  })

  test('with no interval advertised, polls every five seconds (RFC 8628 §3.2)', async () => {
    const op = await stubOp([pending, granted], { interval: undefined })
    const deps = fakeDeps()
    await deviceLogin({ issuer: op.url, resource: RESOURCE, scopes: ['read'] }, deps)
    expect(deps.sleeps).toEqual([5000, 5000])
  })

  test('gives up on expired_token', async () => {
    const op = await stubOp([pending, { status: 400, json: { error: 'expired_token' } }, granted])
    await expect(deviceLogin({ issuer: op.url, resource: RESOURCE, scopes: ['read'] }, fakeDeps()))
      .rejects.toThrow(/expired/)
    // It stopped at the refusal: the third, granting, answer was never asked for.
    expect(op.requests.filter((r) => r.path === '/token')).toHaveLength(2)
  })

  test('gives up on access_denied, saying the request was cancelled', async () => {
    const op = await stubOp([{ status: 400, json: { error: 'access_denied' } }, granted])
    await expect(deviceLogin({ issuer: op.url, resource: RESOURCE, scopes: ['read'] }, fakeDeps()))
      .rejects.toThrow(/cancel/i)
    expect(op.requests.filter((r) => r.path === '/token')).toHaveLength(1)
  })

  test('stops polling once the device code has expired locally', async () => {
    const op = await stubOp([pending], { expires_in: 7, interval: 3 })
    await expect(deviceLogin({ issuer: op.url, resource: RESOURCE, scopes: ['read'] }, fakeDeps()))
      .rejects.toThrow(/expired/)
    // Polls at 3s and 6s; the 9s poll would be after the 7s expiry.
    expect(op.requests.filter((r) => r.path === '/token')).toHaveLength(2)
  })
})

describe('discover', () => {
  test('returns the endpoints of a matching issuer', async () => {
    stub = await startStub()
    serveDiscovery(stub)
    const meta = await discover(stub.url, fakeDeps())
    expect(meta.tokenEndpoint).toBe(`${stub.url}/token`)
    expect(meta.deviceAuthorizationEndpoint).toBe(`${stub.url}/device/auth`)
    expect(meta.revocationEndpoint).toBe(`${stub.url}/token/revocation`)
  })

  test('refuses a document naming a different issuer (RFC 8414 §3.3)', async () => {
    stub = await startStub()
    serveDiscovery(stub, { issuer: 'http://elsewhere.test' })
    await expect(discover(stub.url, fakeDeps())).rejects.toThrow(/issuer/)
  })
})

describe('refresh', () => {
  test('names the resource, and returns the rotated refresh token with the new access token', async () => {
    stub = await startStub()
    serveDiscovery(stub)
    stub.on('POST /token', () => ({ status: 200, json: { ...TOKEN, access_token: 'at-2', refresh_token: 'rt-2', scope: 'read' } }))
    const deps = fakeDeps()
    const cred = await refresh({ issuer: stub.url, resource: RESOURCE, refreshToken: 'rt-1' }, deps)
    const req = stub.requests.find((r) => r.path === '/token')!
    expect(req.form).toEqual({ grant_type: 'refresh_token', refresh_token: 'rt-1', client_id: CLI_CLIENT_ID, resource: RESOURCE })
    expect(cred).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-2', scope: 'read', resource: RESOURCE })
  })

  test('any 4xx is "sign in again", and its message carries no token', async () => {
    stub = await startStub()
    serveDiscovery(stub)
    stub.on('POST /token', () => ({ status: 400, json: { error: 'invalid_grant', error_description: 'grant request is invalid' } }))
    const err = await refresh({ issuer: stub.url, resource: RESOURCE, refreshToken: 'rt-secret-1' }, fakeDeps())
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SignInAgainError)
    expect(String((err as Error).message)).toMatch(/mm login/)
    expect(String((err as Error).message)).not.toContain('rt-secret-1')
  })

  test('a 5xx is not "sign in again": the OP may never have seen the token', async () => {
    stub = await startStub()
    serveDiscovery(stub)
    stub.on('POST /token', () => ({ status: 503, json: { error: 'server_error' } }))
    const err = await refresh({ issuer: stub.url, resource: RESOURCE, refreshToken: 'rt-1' }, fakeDeps()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(SignInAgainError)
    expect(String((err as Error).message)).toMatch(/503/)
  })
})

describe('revokeRefreshToken', () => {
  test('posts the token to the revocation endpoint as the public CLI client', async () => {
    stub = await startStub()
    serveDiscovery(stub)
    stub.on('POST /token/revocation', () => ({ status: 200, text: '' }))
    expect(await revokeRefreshToken({ issuer: stub.url, refreshToken: 'rt-1' }, fakeDeps())).toBe(true)
    const req = stub.requests.find((r) => r.path === '/token/revocation')!
    expect(req.form).toEqual({ token: 'rt-1', token_type_hint: 'refresh_token', client_id: CLI_CLIENT_ID })
    expect(req.headers.authorization).toBeUndefined()
  })

  test('is false, not a throw, when the OP refuses or has no revocation endpoint', async () => {
    stub = await startStub()
    serveDiscovery(stub)
    stub.on('POST /token/revocation', () => ({ status: 503, text: '' }))
    expect(await revokeRefreshToken({ issuer: stub.url, refreshToken: 'rt-1' }, fakeDeps())).toBe(false)
    serveDiscovery(stub, { revocation_endpoint: undefined })
    expect(await revokeRefreshToken({ issuer: stub.url, refreshToken: 'rt-1' }, fakeDeps())).toBe(false)
  })
})
