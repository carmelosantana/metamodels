import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, test, vi } from 'vitest'
import fetchRequest, { isSpecialUseIP } from 'oidc-provider/lib/helpers/fetch_request.js'
import {
  CIMD_ACK, cimdClientAllowed, cimdFeature, cimdGateForIssuer, isAcceptableRedirectUri, isCimdClient, ssrfGuardAvailable,
} from '../src/cimd.js'
import { createProvider } from '../src/provider.js'
import { makeDb } from './helpers/db.js'
import {
  authConfig, CIMD_CLIENT_ID, CIMD_REDIRECT_URI, cimdDocument, CookieJar, pkcePair, send, startTestOp, type TestOp,
} from './helpers/flow.js'

const T = 20_000
let op: TestOp | undefined
afterEach(async () => { await op?.close(); op = undefined; vi.restoreAllMocks() })

/** The first hop of a CIMD client's authorization request. */
async function authorizeFirstHop(clientId: string): Promise<Response> {
  const { challenge } = pkcePair()
  const url = new URL(`${op!.issuer}/auth`)
  url.search = new URLSearchParams({
    client_id: clientId, response_type: 'code', scope: 'openid', redirect_uri: CIMD_REDIRECT_URI,
    state: 's', code_challenge: challenge, code_challenge_method: 'S256',
  }).toString()
  return send(new CookieJar(), url.href)
}

describe('CIMD is enabled, acknowledged and advertised (M4 D4a)', () => {
  test('the acknowledged draft is draft-02: an oidc-provider that moves the draft fails here and at construction', async () => {
    expect(CIMD_ACK).toBe('draft-02')
    expect(cimdFeature()).toMatchObject({ enabled: true, ack: 'draft-02' })
    op = await startTestOp()
    const meta = await (await fetch(`${op.issuer}/.well-known/openid-configuration`)).json()
    expect(meta.client_id_metadata_document_supported).toBe(true)
    expect(meta.registration_endpoint).toBeUndefined()
  }, T)

  test('a CIMD client resolves from its document and starts an interaction', async () => {
    op = await startTestOp({ cimdDocuments: { [CIMD_CLIENT_ID]: cimdDocument() } })
    const res = await authorizeFirstHop(CIMD_CLIENT_ID)
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toMatch(/^\/interaction\//)
    expect(isCimdClient(await op.provider.Client.find(CIMD_CLIENT_ID))).toBe(true)
  }, T)

  test('a document asking for a client secret, or for another grant, is not admitted', async () => {
    const secret = 'https://secret.example.test/client.json'
    // device_code, because this OP enables it: a grant the OP does not support never reaches allowClient (next test).
    const device = 'https://device.example.test/client.json'
    op = await startTestOp({
      cimdDocuments: {
        [secret]: cimdDocument({ client_id: secret, token_endpoint_auth_method: 'client_secret_basic' }),
        [device]: cimdDocument({ client_id: device, grant_types: ['authorization_code', 'urn:ietf:params:oauth:grant-type:device_code'] }),
      },
    })
    for (const id of [secret, device]) {
      const res = await authorizeFirstHop(id)
      expect(res.status, id).toBe(400)
      expect(await res.text(), id).toContain('Sign-in error')
    }
    expect(await (await authorizeFirstHop(device)).text()).toContain('client is not allowed')
  }, T)

  test('oidc-provider drops a grant the OP does not support from a document before allowClient runs', async () => {
    const cc = 'https://cc.example.test/client.json'
    op = await startTestOp({
      cimdDocuments: { [cc]: cimdDocument({ client_id: cc, grant_types: ['authorization_code', 'client_credentials'] }) },
    })
    const client = await op.provider.Client.find(cc)
    expect(isCimdClient(client)).toBe(true)
    expect(client!.grantTypes).toEqual(['authorization_code'])
    // And nothing grants client_credentials: the grant is not enabled on this OP at all.
    const res = await fetch(`${op.issuer}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: cc }).toString(),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('unsupported_grant_type')
  }, T)

  test('first-party clients are not CIMD clients', async () => {
    op = await startTestOp()
    expect(isCimdClient(await op.provider.Client.find('metamodels-cli'))).toBe(false)
    expect(isCimdClient(undefined)).toBe(false)
  }, T)
})

describe('the issuer-scheme gate', () => {
  test('https, and plain http to a loopback host, turn CIMD on', () => {
    for (const issuer of ['https://auth.example.test', 'http://localhost:3100', 'http://127.0.0.1:3100', 'http://[::1]:3100']) {
      expect(cimdGateForIssuer(issuer), issuer).toEqual({ enabled: true })
    }
  })

  test('any other issuer boots with CIMD off, and says why', async () => {
    const gate = cimdGateForIssuer('http://auth.example.test')
    expect(gate).toMatchObject({ enabled: false, reason: expect.stringContaining('http://auth.example.test') })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const provider = createProvider(authConfig('http://auth.example.test'), await makeDb())
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Client ID Metadata Documents are off'))
    const server = createServer(provider.callback())
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      const meta = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/.well-known/openid-configuration`)).json()
      expect(meta.client_id_metadata_document_supported).toBeUndefined()
    } finally {
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
    }
  }, T)
})

describe('the admission policy', () => {
  const allowFetch = (id: string) => cimdFeature().allowFetch(undefined as never, id)

  test('allowFetch accepts only the library\'s own well-formed client id URLs', () => {
    expect(allowFetch('https://client.example.test/cimd.json')).toBe(true)
    for (const id of [
      'http://client.example.test/cimd.json', 'https://client.example.test/cimd.json#x',
      'https://user@client.example.test/cimd.json', 'https://client.example.test/a/../cimd.json',
    ]) expect(allowFetch(id), id).toBe(false)
  })

  test('allowClient: public, code and refresh only, https or loopback redirects', () => {
    const ok = { tokenEndpointAuthMethod: 'none', grantTypes: ['authorization_code', 'refresh_token'], redirectUris: ['https://app.example.test/cb', 'http://127.0.0.1:9/cb'] }
    expect(cimdClientAllowed(ok)).toBe(true)
    expect(cimdClientAllowed({ ...ok, tokenEndpointAuthMethod: 'private_key_jwt' })).toBe(false)
    expect(cimdClientAllowed({ ...ok, grantTypes: ['authorization_code', 'urn:ietf:params:oauth:grant-type:device_code'] })).toBe(false)
    expect(cimdClientAllowed({ ...ok, grantTypes: [] })).toBe(false)
    expect(cimdClientAllowed({ ...ok, redirectUris: ['http://app.example.test/cb'] })).toBe(false)
    expect(cimdClientAllowed({ ...ok, redirectUris: [] })).toBe(false)
  })

  test('a redirect URI is https, or http to a loopback host, and has no fragment', () => {
    for (const uri of ['https://a.test/cb', 'http://localhost:8080/cb', 'http://127.0.0.1/cb', 'http://[::1]:1/cb']) {
      expect(isAcceptableRedirectUri(uri), uri).toBe(true)
    }
    for (const uri of ['http://a.test/cb', 'https://a.test/cb#f', 'custom:/cb', 'not a url']) {
      expect(isAcceptableRedirectUri(uri), uri).toBe(false)
    }
  })
})

describe('SSRF: the CIMD fetch cannot reach special-use addresses (M4 §3.4)', () => {
  test('the guard oidc-provider installs is present in this runtime', () => {
    expect(ssrfGuardAvailable()).toBe(true)
  })

  // Loopback by IP literal, proven live. A name resolving to RFC 1918 space cannot be faked offline
  // (no test DNS), so that half of the spec's requirement is the isSpecialUseIP table below (§10).
  test('a fetch to 127.0.0.1 is refused on connect', async () => {
    const server = createServer((_req, res) => res.end('reachable'))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    const provider = createProvider(authConfig('http://127.0.0.1:1'), await makeDb())
    try {
      // Control: the server is really there.
      expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200)
      const url = `http://127.0.0.1:${port}/`
      const err = await fetchRequest(provider, url, { method: 'GET', headers: {} }).then(() => null, (e: unknown) => e)
      expect(err, url).not.toBeNull()
      expect(String((err as Error & { cause?: Error }).cause?.message ?? err), url).toContain('special-use IP address')
    } finally {
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
    }
  }, T)

  test('RFC 1918, CGNAT and link-local space are all special-use; public space is not', () => {
    for (const ip of ['10.1.2.3', '172.16.5.4', '172.31.255.1', '192.168.255.254', '100.64.0.1', '169.254.1.1', '::1', 'fd00::1']) {
      expect(isSpecialUseIP(ip), ip).toBe(true)
    }
    expect(isSpecialUseIP('8.8.8.8')).toBe(false)
  })

  test('without the guard, the OP refuses to start with CIMD on', async () => {
    expect(() => createProvider(authConfig('http://127.0.0.1:1'), {} as never, { ssrfGuardAvailable: () => false }))
      .toThrow(/SSRF guard/)
  })
})
