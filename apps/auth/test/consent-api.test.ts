import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest'
import { createLocalJWKSet, jwtVerify, type JWK } from 'jose'
import { internalApiAudience } from '@metamodels/schema'
import {
  CONSENT_ASSERTION_TTL_S, consentAsserter, httpConsentApi, MINT_DENIED_PADDOCK, MINT_DENIED_ROLE, PREFLIGHT_UNAVAILABLE,
} from '../src/consent-api.js'
import { signingJwks } from '../src/keys.js'

const ISSUER = 'https://auth.example.test'
const CONSOLE = 'https://console.example.test'
const signer = signingJwks(null, true).keys[0]!
const publicJwk = (({ kty, n, e, kid, alg, use }) => ({ kty, n, e, kid, alg, use }))(signer as JWK & Record<string, string>)
const request = {
  accountId: '11111111-1111-4111-8111-111111111111', clientId: 'https://client.example.test/cimd.json',
  clientName: 'Claude', resource: 'https://dp.example.test/p/small/mcp',
}

describe('consentAsserter', () => {
  test('signs an mm-consent+jwt the control plane can verify against the OP\'s published key', async () => {
    const assert = consentAsserter({ issuer: ISSUER, consoleUrl: CONSOLE, signingJwk: signer })
    const jwt = assert({ ...request, grantId: 'grant-1' })
    const { payload, protectedHeader } = await jwtVerify(jwt, createLocalJWKSet({ keys: [publicJwk as JWK] }), {
      issuer: ISSUER, audience: internalApiAudience(CONSOLE), typ: 'mm-consent+jwt', algorithms: ['RS256'],
    })
    expect(protectedHeader.kid).toBe(signer.kid)
    expect(payload).toMatchObject({
      sub: request.accountId, client_id: request.clientId, client_name: 'Claude',
      resource: request.resource, grant_id: 'grant-1',
    })
    expect(payload.exp! - payload.iat!).toBe(CONSENT_ASSERTION_TTL_S)
    expect(CONSENT_ASSERTION_TTL_S).toBeLessThanOrEqual(60)
  })

  test('every assertion has its own jti, and a preflight assertion names no grant', async () => {
    const assert = consentAsserter({ issuer: ISSUER, consoleUrl: CONSOLE, signingJwk: signer })
    const read = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8'))
    const a = read(assert(request))
    const b = read(assert(request))
    expect(a.jti).not.toBe(b.jti)
    expect('grant_id' in a).toBe(false)
  })
})

describe('httpConsentApi', () => {
  let server: Server
  let base: string
  let seen: Array<{ method: string; url: string; auth: string | undefined }>
  let reply: { status: number; body: unknown }
  // Failure paths warn by design; capture them so the run stays quiet and the warnings are checkable.
  let warn: MockInstance<typeof console.warn>

  beforeEach(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    seen = []
    reply = { status: 200, body: {} }
    server = createServer((req, res) => {
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization })
      res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    warn.mockRestore()
    await new Promise<void>((r) => server.close(() => r()))
  })

  const api = () => httpConsentApi({ baseUrl: base, assert: (r) => `assertion-for-${r.grantId ?? 'preflight'}` })

  test('preflight GETs the internal route with the assertion as a bearer', async () => {
    reply = { status: 200, body: { allowed: true, reason: null } }
    expect(await api().preflight(request)).toEqual({ allowed: true })
    expect(seen).toEqual([{ method: 'GET', url: '/api/internal/v1/oauth-keys/preflight', auth: 'Bearer assertion-for-preflight' }])
  })

  test('preflight relays a refusal\'s reason, and turns any failure into a refusal', async () => {
    reply = { status: 200, body: { allowed: false, reason: 'Your role cannot approve apps.' } }
    expect(await api().preflight(request)).toEqual({ allowed: false, reason: 'Your role cannot approve apps.' })
    reply = { status: 500, body: {} }
    expect(await api().preflight(request)).toEqual({ allowed: false, reason: PREFLIGHT_UNAVAILABLE })
    const down = httpConsentApi({ baseUrl: 'http://127.0.0.1:1', assert: () => 'x' })
    expect(await down.preflight(request)).toEqual({ allowed: false, reason: PREFLIGHT_UNAVAILABLE })
  })

  test('a failed preflight tells the operator why, never with the assertion', async () => {
    reply = { status: 401, body: {} }
    expect(await api().preflight(request)).toEqual({ allowed: false, reason: PREFLIGHT_UNAVAILABLE })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toMatch(/^\[consent\] preflight failed: .*401/)
    const down = httpConsentApi({ baseUrl: 'http://127.0.0.1:1', assert: () => 'secret-assertion' })
    expect(await down.preflight(request)).toEqual({ allowed: false, reason: PREFLIGHT_UNAVAILABLE })
    expect(warn).toHaveBeenCalledTimes(2)
    expect(String(warn.mock.calls[1]![0])).toMatch(/^\[consent\] preflight failed: /)
    for (const call of warn.mock.calls) expect(call.join(' ')).not.toMatch(/assertion|Bearer/)
  })

  test('mint POSTs and returns the key id', async () => {
    reply = { status: 200, body: { key_id: 'key-1' } }
    expect(await api().mint({ ...request, grantId: 'grant-1' })).toEqual({ ok: true, keyId: 'key-1' })
    expect(seen).toEqual([{ method: 'POST', url: '/api/internal/v1/oauth-keys', auth: 'Bearer assertion-for-grant-1' }])
  })

  test('mint: 403 and 404 are a denial with a reason; anything else is an error', async () => {
    reply = { status: 403, body: {} }
    expect(await api().mint({ ...request, grantId: 'g' })).toEqual({ ok: false, kind: 'denied', reason: MINT_DENIED_ROLE })
    reply = { status: 404, body: {} }
    expect(await api().mint({ ...request, grantId: 'g' })).toEqual({ ok: false, kind: 'denied', reason: MINT_DENIED_PADDOCK })
    reply = { status: 401, body: {} }
    expect(await api().mint({ ...request, grantId: 'g' })).toMatchObject({ ok: false, kind: 'error' })
    reply = { status: 200, body: {} }
    expect(await api().mint({ ...request, grantId: 'g' })).toMatchObject({ ok: false, kind: 'error' })
    const down = httpConsentApi({ baseUrl: 'http://127.0.0.1:1', assert: () => 'x' })
    expect(await down.mint({ ...request, grantId: 'g' })).toMatchObject({ ok: false, kind: 'error' })
  })
})
