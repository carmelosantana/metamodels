import { afterEach, describe, expect, test } from 'vitest'
import { jwtVerify } from 'jose'
import { adminApiResource, CAPABILITIES, CONSOLE_CLIENT_ID } from '@metamodels/schema'
import { resourceServers } from '../src/resources.js'
import { seedUser } from './helpers/db.js'
import { authorize, CONSOLE_URL, exchangeCode, opJwks, startTestOp, type TestOp } from './helpers/flow.js'

const T = 20_000
const ADMIN = adminApiResource(CONSOLE_URL)
let op: TestOp | undefined
afterEach(async () => { await op?.close(); op = undefined })

async function signedIn(scope: string, resource?: string) {
  op = await startTestOp()
  const id = await seedUser(op.db, { email: 'admin@x.io', password: 'hunter2hunter2' })
  const out = await authorize(op, {
    email: 'admin@x.io', password: 'hunter2hunter2', scope, extra: resource ? { resource } : {},
  })
  return { id, out }
}

describe('resource servers', () => {
  test('the admin API resource declares exactly the capability scopes', () => {
    const rs = resourceServers(CONSOLE_URL).get(ADMIN)
    expect(ADMIN).toBe('http://console.test/api/admin')
    expect(rs?.scope.split(' ')).toEqual([...CAPABILITIES])
    expect(rs?.accessTokenFormat).toBe('jwt')
  })

  test('requesting the admin API yields an RFC 9068 JWT bound to it', async () => {
    const { id, out } = await signedIn('openid read resource.write', ADMIN)
    if (out.kind !== 'redirect' || !out.url.searchParams.get('code')) throw new Error('expected a code')
    const token = await exchangeCode(op!, out.url.searchParams.get('code')!, out.verifier, { resource: ADMIN })
    expect(token.status).toBe(200)

    const { payload, protectedHeader } = await jwtVerify(token.json.access_token as string, await opJwks(op!), {
      issuer: op!.issuer, audience: ADMIN, typ: 'at+jwt', algorithms: ['RS256'],
    })
    expect(protectedHeader.alg).toBe('RS256')
    expect(payload.sub).toBe(id)
    expect(payload.client_id).toBe(CONSOLE_CLIENT_ID)
    expect(String(payload.scope).split(' ').sort()).toEqual(['read', 'resource.write'])
    expect(typeof payload.jti).toBe('string')
    expect(payload.exp! - payload.iat!).toBe(3600)
  }, T)

  test('a token carries only the scopes that were asked for', async () => {
    const { out } = await signedIn('openid read', ADMIN)
    if (out.kind !== 'redirect') throw new Error('expected a code')
    const token = await exchangeCode(op!, out.url.searchParams.get('code')!, out.verifier, { resource: ADMIN })
    const { payload } = await jwtVerify(token.json.access_token as string, await opJwks(op!), { issuer: op!.issuer, audience: ADMIN })
    expect(payload.scope).toBe('read')
  }, T)

  test('an undeclared resource is refused with invalid_target', async () => {
    const { out } = await signedIn('openid read', 'http://evil.test/api')
    if (out.kind !== 'redirect') throw new Error('expected an error redirect to the client')
    expect(out.url.searchParams.get('error')).toBe('invalid_target')
    expect(out.url.searchParams.get('code')).toBeNull()
  }, T)

  test('without a resource, no JWT access token is issued', async () => {
    const { out } = await signedIn('openid')
    if (out.kind !== 'redirect') throw new Error('expected a code')
    const token = await exchangeCode(op!, out.url.searchParams.get('code')!, out.verifier)
    expect(token.status).toBe(200)
    expect(String(token.json.access_token).split('.')).not.toHaveLength(3)
  }, T)
})
