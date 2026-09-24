import { afterEach, describe, expect, test } from 'vitest'
import { jwtVerify } from 'jose'
import { errors, type ResourceServer } from 'oidc-provider'
import { adminApiResource, CAPABILITIES, CLI_CLIENT_ID, CONSOLE_CLIENT_ID } from '@metamodels/schema'
import {
  accessTokenTtl, makeGetResourceServerInfo, resourcesByClient, resourceServers,
} from '../src/resources.js'
import { seedUser } from './helpers/db.js'
import {
  approveDevice, authorize, CONSOLE_URL, deviceAuthorization, deviceToken, exchangeCode, opJwks, startTestOp,
  type DeviceAuthorization, type TestOp,
} from './helpers/flow.js'

const T = 20_000
const ADMIN = adminApiResource(CONSOLE_URL)
const EMAIL = 'admin@x.io'
const PASSWORD = 'hunter2hunter2'
let op: TestOp | undefined
afterEach(async () => { await op?.close(); op = undefined })

/** The console's authorization-code flow, signed in; `resource` is added to the request when given. */
async function signedIn(scope: string, resource?: string) {
  op = await startTestOp()
  const id = await seedUser(op.db, { email: EMAIL, password: PASSWORD })
  const out = await authorize(op, { email: EMAIL, password: PASSWORD, scope, extra: resource ? { resource } : {} })
  return { id, out }
}

/** The CLI's device flow for `scope`, approved in a browser; returns the token response. */
async function cliToken(scope: string) {
  op = await startTestOp()
  const id = await seedUser(op.db, { email: EMAIL, password: PASSWORD })
  const auth = await deviceAuthorization(op, { scope, resource: ADMIN })
  expect(auth.status).toBe(200)
  await approveDevice(op, auth.json as unknown as DeviceAuthorization, { email: EMAIL, password: PASSWORD })
  const token = await deviceToken(op, String(auth.json.device_code), { resource: ADMIN })
  expect(token.status).toBe(200)
  return { id, token }
}

describe('resource servers', () => {
  test('the admin API resource declares exactly the capability scopes', () => {
    const rs = resourceServers(CONSOLE_URL).get(ADMIN)
    expect(ADMIN).toBe('http://console.test/api/admin')
    expect(rs?.scope.split(' ')).toEqual([...CAPABILITIES])
    expect(rs?.accessTokenFormat).toBe('jwt')
  })

  test('requesting the admin API yields an RFC 9068 JWT bound to it', async () => {
    const { id, token } = await cliToken('openid read resource.write')
    const { payload, protectedHeader } = await jwtVerify(token.json.access_token as string, await opJwks(op!), {
      issuer: op!.issuer, audience: ADMIN, typ: 'at+jwt', algorithms: ['RS256'],
    })
    expect(protectedHeader.alg).toBe('RS256')
    // Exactly this audience, not merely one of several: jose's `audience` option is a membership
    // check, so a widened `aud` array would still satisfy jwtVerify while destroying the audience
    // restriction M2 and M4 depend on.
    expect(payload.aud).toBe(ADMIN)
    expect(payload.sub).toBe(id)
    expect(payload.client_id).toBe(CLI_CLIENT_ID)
    expect(String(payload.scope).split(' ').sort()).toEqual(['read', 'resource.write'])
    expect(typeof payload.jti).toBe('string')
    expect(payload.exp! - payload.iat!).toBe(3600)
  }, T)

  test('a token carries only the scopes that were asked for', async () => {
    const { token } = await cliToken('openid read')
    const { payload } = await jwtVerify(token.json.access_token as string, await opJwks(op!), { issuer: op!.issuer, audience: ADMIN })
    expect(payload.aud).toBe(ADMIN)
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

/**
 * The gate. `getResourceServerInfo` is the only place oidc-provider asks "may THIS client have a
 * token for THAT resource" — at the authorization, device-authorization and token endpoints, and on
 * every refresh. Each denial below is paired with an allowed call of the same shape, so a gate that
 * refuses everything cannot pass.
 */
describe('per-client resource gating', () => {
  const OTHER = 'http://paddock.test/mcp'
  const servers: ReadonlyMap<string, ResourceServer> = new Map([
    ...resourceServers(CONSOLE_URL),
    [OTHER, { scope: 'read', accessTokenFormat: 'jwt' }],
  ])
  // Arbitrary ids: these pin the gate's logic, not the production map (tested below).
  const A = 'client-a'
  const B = 'client-b'
  const get = makeGetResourceServerInfo(servers, new Map([
    [A, new Set([ADMIN])],
    [B, new Set([ADMIN, OTHER])],
  ]))
  const client = (clientId: string) => ({ clientId })

  test('a known client gets a resource it is allowed', async () => {
    await expect(get({}, ADMIN, client(A))).resolves.toBe(servers.get(ADMIN))
    await expect(get({}, ADMIN, client(B))).resolves.toBe(servers.get(ADMIN))
    await expect(get({}, OTHER, client(B))).resolves.toBe(servers.get(OTHER))
  })

  test('an unknown client is refused a resource a known client gets', async () => {
    await expect(get({}, ADMIN, client(A))).resolves.toBeDefined()
    await expect(get({}, ADMIN, client('someone-else'))).rejects.toThrow(errors.InvalidTarget)
  })

  test('a known client is refused a declared resource outside its own set', async () => {
    await expect(get({}, OTHER, client(B))).resolves.toBeDefined()
    await expect(get({}, OTHER, client(A))).rejects.toThrow(errors.InvalidTarget)
  })

  test('an undeclared resource is refused even to a client that lists it', async () => {
    const lax = makeGetResourceServerInfo(servers, new Map([[B, new Set(['http://ghost.test/api', ADMIN])]]))
    await expect(lax({}, ADMIN, client(B))).resolves.toBeDefined()
    await expect(lax({}, 'http://ghost.test/api', client(B))).rejects.toThrow(errors.InvalidTarget)
  })

  test('the production map lets exactly the CLI ask for the admin API', () => {
    const allowed = resourcesByClient(CONSOLE_URL)
    expect([...allowed.keys()]).toEqual([CLI_CLIENT_ID])
    expect([...allowed.get(CLI_CLIENT_ID)!]).toEqual([ADMIN])
    // The console signs operators in (`openid` only) and needs no admin-API token (spec A15).
    expect(allowed.has(CONSOLE_CLIENT_ID)).toBe(false)
  })

  /**
   * Spec A15. The console's authorization-code flow auto-consents on a live OP session with no fresh
   * password, so an admin-API token for the console would be the console secret plus an
   * authorization request with the attacker's own PKCE verifier away from `user.manage`. The
   * refusal is paired with the same console, signed in without the resource, which still gets a code.
   */
  test('through the real OP: the console is refused the admin API at the authorization endpoint', async () => {
    const { out: control } = await signedIn('openid')
    if (control.kind !== 'redirect') throw new Error('expected a code')
    expect(control.url.searchParams.get('code')).toBeTruthy()

    // The same browser, its OP session live: no login form, and still no code for the admin API.
    const out = await authorize(op!, { scope: 'openid read user.manage', extra: { resource: ADMIN }, jar: control.jar })
    if (out.kind !== 'redirect') throw new Error(`expected an error redirect to the console, got ${out.status}`)
    expect(out.url.searchParams.get('error')).toBe('invalid_target')
    expect(out.url.searchParams.get('code')).toBeNull()
  }, T)

  /**
   * The same refusal at the token endpoint: a code from the console's ordinary `openid` sign-in,
   * exchanged with `resource` naming the admin API. Paired with a second code from the same browser,
   * exchanged without it, which succeeds.
   */
  test('through the real OP: the console is refused the admin API at the token endpoint', async () => {
    const { out: control } = await signedIn('openid')
    if (control.kind !== 'redirect') throw new Error('expected a code')
    const ok = await exchangeCode(op!, control.url.searchParams.get('code')!, control.verifier)
    expect(ok.status).toBe(200)

    const out = await authorize(op!, { jar: control.jar })
    if (out.kind !== 'redirect') throw new Error(`expected a silent sign-in, got ${out.status}`)
    const code = out.url.searchParams.get('code')
    expect(code).toBeTruthy()
    const token = await exchangeCode(op!, code!, out.verifier, { resource: ADMIN })
    expect(token.status).toBe(400)
    expect(token.json.error).toBe('invalid_target')
    expect(token.json.access_token).toBeUndefined()
  }, T)

  test('through the real OP: a registered but ungranted client is refused the admin API', async () => {
    op = await startTestOp({
      extraClients: [{
        client_id: 'third-party',
        client_secret: 'third-party-secret-0123',
        redirect_uris: ['http://third.test/cb'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      }],
    })
    // The same client without the resource: allowed — it reaches the login form rather than an error.
    const control = await authorize(op, { clientId: 'third-party', redirectUri: 'http://third.test/cb', scope: 'openid' })
    if (control.kind !== 'page') throw new Error(`expected the client to reach login, got ${control.url.href}`)
    expect(control.body).toContain('<form method="post"')

    const out = await authorize(op, {
      clientId: 'third-party', redirectUri: 'http://third.test/cb', scope: 'openid read', extra: { resource: ADMIN },
    })
    if (out.kind !== 'redirect') throw new Error(`expected an error redirect to the client, got ${out.status}`)
    expect(out.url.searchParams.get('error')).toBe('invalid_target')
    expect(out.url.searchParams.get('code')).toBeNull()
  }, T)
})

/**
 * `ttl.AccessToken` must stay a FUNCTION in provider.ts. oidc-provider's `BaseToken.expiresIn`
 * returns a numeric `ttl.AccessToken` directly and never consults the token's resource server, so
 * a static number would silently ignore every `resourceServer.accessTokenTTL` — including the
 * per-paddock ones M4 declares. These pin both directions, which `exp - iat === 3600` cannot.
 */
describe('access-token TTL', () => {
  test('a resource server governs its own access-token lifetime', () => {
    expect(accessTokenTtl({}, { resourceServer: { accessTokenTTL: 900 } })).toBe(900)
  })

  test('a token bound to no resource server falls back to an hour', () => {
    expect(accessTokenTtl({}, {})).toBe(3600)
    expect(accessTokenTtl({}, { resourceServer: {} })).toBe(3600)
  })

  test('the admin API resource declares the TTL its tokens actually get', () => {
    const rs = resourceServers(CONSOLE_URL).get(ADMIN)!
    expect(rs.accessTokenTTL).toBe(3600)
    expect(accessTokenTtl({}, { resourceServer: rs })).toBe(3600)
  })
})
