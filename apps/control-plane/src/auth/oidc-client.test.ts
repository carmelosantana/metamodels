import { afterEach, describe, expect, test } from 'vitest'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { CONSOLE_CLIENT_ID } from '@metamodels/schema'
import {
  codeChallenge, loadOidcClientConfig, newTransaction, OidcClient, onOrigin, parseTransaction,
  type AuthTransaction, type OidcClientConfig,
} from './oidc-client'

const SUB = '00000000-0000-4000-8000-000000000001'
const SECRET = 'console-secret-0123456789'
const TX = { state: 'st', nonce: 'expected-nonce', codeVerifier: 'v'.repeat(43) }

/** A minimal OP: discovery, JWKS and a token endpoint that mints a real RS256 ID token. */
interface StubOp {
  port: number
  issuer: string
  discoveryCount: number
  tokenRequests: Array<{ host: string; authorization: string; body: URLSearchParams }>
  /** The `Host` each JWKS fetch arrived on — proof of which origin the key set was pulled from. */
  jwksRequests: string[]
  idTokenClaims: Record<string, unknown>
  audience: string
  tokenStatus: number
  discoveryIssuer?: string
  /** When set, discovery advertises endpoints on this origin whatever `Host` the request carried. */
  endpointOrigin?: string
  close(): Promise<void>
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function startStubOp(): Promise<StubOp> {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
  const op = {
    port: 0, issuer: '', discoveryCount: 0, tokenRequests: [], jwksRequests: [], idTokenClaims: {},
    audience: CONSOLE_CLIENT_ID, tokenStatus: 200,
  } as unknown as StubOp
  const server = createServer(async (req, res) => {
    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    const path = (req.url ?? '/').split('?')[0]
    if (path === '/.well-known/openid-configuration') {
      op.discoveryCount += 1
      // Like oidc-provider (OIDCContext#urlFor resolves against the request URL), endpoints are
      // built from the Host the request arrived on, not from the issuer. `endpointOrigin` overrides
      // that to model an OP behind a proxy that rewrites Host to the public name.
      const base = op.endpointOrigin ?? `http://${req.headers.host}`
      return json(200, {
        issuer: op.discoveryIssuer ?? op.issuer,
        authorization_endpoint: `${base}/auth`,
        token_endpoint: `${base}/token`,
        jwks_uri: `${base}/jwks`,
        end_session_endpoint: `${base}/session/end`,
      })
    }
    if (path === '/jwks') {
      op.jwksRequests.push(req.headers.host ?? '')
      return json(200, { keys: [jwk] })
    }
    if (path === '/token' && req.method === 'POST') {
      op.tokenRequests.push({ host: req.headers.host ?? '', authorization: req.headers.authorization ?? '', body: new URLSearchParams(await body(req)) })
      if (op.tokenStatus !== 200) return json(op.tokenStatus, { error: 'invalid_grant' })
      const idToken = await new SignJWT({ nonce: 'expected-nonce', ...op.idTokenClaims })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(op.issuer).setAudience(op.audience).setSubject(SUB)
        .setIssuedAt().setExpirationTime('5m')
        .sign(privateKey)
      return json(200, { access_token: 'opaque', token_type: 'Bearer', id_token: idToken })
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  op.port = (server.address() as AddressInfo).port
  op.issuer = `http://127.0.0.1:${op.port}`
  op.close = () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) })
  return op
}

let op: StubOp | undefined
afterEach(async () => { await op?.close(); op = undefined })

function cfg(o: StubOp, over: Partial<OidcClientConfig> = {}): OidcClientConfig {
  return { issuer: o.issuer, internalUrl: o.issuer, consoleUrl: 'https://console.example.test', clientSecret: SECRET, ...over }
}

describe('configuration and primitives', () => {
  test('loadOidcClientConfig normalises origins and defaults the back channel to the issuer', () => {
    const c = loadOidcClientConfig({
      OIDC_ISSUER: 'https://auth.example.test/', CONSOLE_URL: 'https://console.example.test', CONSOLE_CLIENT_SECRET: SECRET,
    })
    expect(c).toEqual({
      issuer: 'https://auth.example.test', internalUrl: 'https://auth.example.test',
      consoleUrl: 'https://console.example.test', clientSecret: SECRET,
    })
  })

  test('loadOidcClientConfig rejects a missing secret and a URL with a path', () => {
    expect(() => loadOidcClientConfig({ OIDC_ISSUER: 'https://a.test', CONSOLE_URL: 'https://c.test' })).toThrow('CONSOLE_CLIENT_SECRET')
    expect(() => loadOidcClientConfig({ OIDC_ISSUER: 'https://a.test/x', CONSOLE_URL: 'https://c.test', CONSOLE_CLIENT_SECRET: SECRET })).toThrow('OIDC_ISSUER must be an origin')
  })

  test('codeChallenge matches the RFC 7636 appendix B vector', () => {
    expect(codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  test('newTransaction yields distinct, high-entropy values', () => {
    const a = newTransaction()
    const b = newTransaction()
    expect(a.state).not.toBe(b.state)
    for (const v of [a.state, a.nonce, a.codeVerifier]) expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  test('onOrigin swaps only the origin', () => {
    expect(onOrigin('https://auth.example.test/token?x=1', 'http://auth:3100')).toBe('http://auth:3100/token?x=1')
  })
})

describe('OidcClient', () => {
  test('builds an authorization URL carrying PKCE, state, nonce and an optional login hint', async () => {
    op = await startStubOp()
    const url = new URL(await new OidcClient(cfg(op)).authorizationUrl(TX, 'me@x.io'))
    expect(url.origin + url.pathname).toBe(`${op.issuer}/auth`)
    const p = url.searchParams
    expect(p.get('client_id')).toBe(CONSOLE_CLIENT_ID)
    expect(p.get('response_type')).toBe('code')
    expect(p.get('scope')).toBe('openid')
    expect(p.get('redirect_uri')).toBe('https://console.example.test/auth/callback')
    expect(p.get('state')).toBe('st')
    expect(p.get('nonce')).toBe('expected-nonce')
    expect(p.get('code_challenge')).toBe(codeChallenge(TX.codeVerifier))
    expect(p.get('code_challenge_method')).toBe('S256')
    expect(p.get('login_hint')).toBe('me@x.io')
  })

  test('a login hint forces a fresh login; no hint sends neither hint nor prompt', async () => {
    op = await startStubOp()
    const client = new OidcClient(cfg(op))
    // login_hint alone never makes the OP prompt: a browser already holding an OP session (say an
    // admin opening an invite link) would be silently signed in as that other user.
    const hinted = new URL(await client.authorizationUrl(TX, 'invitee@x.io')).searchParams
    expect(hinted.get('login_hint')).toBe('invitee@x.io')
    expect(hinted.get('prompt')).toBe('login')
    const plain = new URL(await client.authorizationUrl(TX)).searchParams
    expect(plain.has('login_hint')).toBe(false)
    expect(plain.has('prompt')).toBe(false)
  })

  test('exchanges a code with client_secret_basic and returns the verified subject', async () => {
    op = await startStubOp()
    expect(await new OidcClient(cfg(op)).exchangeCode('the-code', TX)).toEqual({ sub: SUB })
    const req = op.tokenRequests[0]
    expect(Buffer.from(req.authorization.replace('Basic ', ''), 'base64').toString()).toBe(`${CONSOLE_CLIENT_ID}:${SECRET}`)
    expect(Object.fromEntries(req.body)).toEqual({
      grant_type: 'authorization_code', code: 'the-code',
      redirect_uri: 'https://console.example.test/auth/callback', code_verifier: TX.codeVerifier,
    })
  })

  test('calls the OP through the back channel, but sends browsers to the public issuer', async () => {
    op = await startStubOp()
    const internal = op.issuer                    // what the console can actually reach
    op.issuer = `http://localhost:${op.port}`     // what the OP advertises and signs as `iss`
    const client = new OidcClient(cfg(op, { issuer: op.issuer, internalUrl: internal }))
    // Discovery came over the back channel, so the OP named the internal host in its endpoints.
    // A browser sent there would fail (in Docker: http://auth:3100 is unresolvable outside).
    expect(new URL(await client.authorizationUrl(TX)).origin).toBe(op.issuer)
    expect(new URL(await client.endSessionUrl()).origin).toBe(op.issuer)
    expect(await client.exchangeCode('c', TX)).toEqual({ sub: SUB })
    expect(op.tokenRequests[0].host).toBe(`127.0.0.1:${op.port}`)
  })

  test('keeps the token and JWKS calls on the back channel when the OP advertises public endpoints', async () => {
    op = await startStubOp()
    const internal = op.issuer                    // the only origin this process can actually reach
    op.issuer = `http://localhost:${op.port}`     // the public name, signed as `iss`
    // An OP behind a proxy that rewrites Host advertises PUBLIC endpoints even to a back-channel
    // caller. The server-to-server calls must still be re-homed onto internalUrl; without that,
    // the console would dial the public name, which in Docker is unreachable from inside the network.
    op.endpointOrigin = op.issuer
    const client = new OidcClient(cfg(op, { issuer: op.issuer, internalUrl: internal }))
    expect(await client.exchangeCode('c', TX)).toEqual({ sub: SUB })
    expect(op.tokenRequests[0].host).toBe(`127.0.0.1:${op.port}`)
    expect(op.jwksRequests).toEqual([`127.0.0.1:${op.port}`])
    // The browser-facing half is unaffected: it still points at the public issuer.
    expect(new URL(await client.authorizationUrl(TX)).origin).toBe(op.issuer)
  })

  test('rejects an ID token with the wrong nonce', async () => {
    op = await startStubOp()
    op.idTokenClaims = { nonce: 'someone-elses-nonce' }
    await expect(new OidcClient(cfg(op)).exchangeCode('c', TX)).rejects.toThrow('nonce mismatch')
  })

  test('rejects a transaction with no usable nonce, even when the ID token also omits the claim', async () => {
    op = await startStubOp()
    op.idTokenClaims = { nonce: undefined }  // JSON.stringify drops it: the ID token carries no nonce
    // Task 11 reconstitutes the transaction from a sealed cookie, and `openJson` returns
    // Record<string, unknown>. Casting instead of validating is the realistic mistake, so build the
    // transaction exactly that way: `undefined !== undefined` is false, and a bare comparison would
    // have accepted this token.
    const fromCookie = (payload: Record<string, unknown>) => payload as unknown as AuthTransaction
    const client = new OidcClient(cfg(op))
    await expect(client.exchangeCode('c', fromCookie({ state: 'st', codeVerifier: 'v'.repeat(43) })))
      .rejects.toThrow('nonce mismatch')
    await expect(client.exchangeCode('c', fromCookie({ state: 'st', nonce: '', codeVerifier: 'v'.repeat(43) })))
      .rejects.toThrow('nonce mismatch')
  })

  test('rejects an ID token issued for another client', async () => {
    op = await startStubOp()
    op.audience = 'some-other-client'
    await expect(new OidcClient(cfg(op)).exchangeCode('c', TX)).rejects.toThrow()
  })

  test('surfaces a token-endpoint error', async () => {
    op = await startStubOp()
    op.tokenStatus = 400
    await expect(new OidcClient(cfg(op)).exchangeCode('c', TX)).rejects.toThrow('token exchange failed: invalid_grant')
  })

  test('refuses a discovery document for a different issuer', async () => {
    op = await startStubOp()
    op.discoveryIssuer = 'https://impostor.example.test'
    await expect(new OidcClient(cfg(op)).metadata()).rejects.toThrow('issuer mismatch')
  })

  test('caches discovery for five minutes', async () => {
    op = await startStubOp()
    let now = 0
    const client = new OidcClient(cfg(op), () => now)
    await client.metadata()
    await client.metadata()
    expect(op.discoveryCount).toBe(1)
    now += 5 * 60 * 1000
    await client.metadata()
    expect(op.discoveryCount).toBe(2)
  })

  test('builds the RP-initiated logout URL back to the console login', async () => {
    op = await startStubOp()
    const url = new URL(await new OidcClient(cfg(op)).endSessionUrl())
    expect(url.origin + url.pathname).toBe(`${op.issuer}/session/end`)
    expect(url.searchParams.get('client_id')).toBe(CONSOLE_CLIENT_ID)
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('https://console.example.test/login')
  })
})

describe('parseTransaction', () => {
  const good = { state: 'st', nonce: 'expected-nonce', codeVerifier: 'v'.repeat(43) }

  test('a well-formed sealed payload becomes an AuthTransaction and nothing else', () => {
    // openJson stamps `exp` onto every payload it returns; only the three fields survive.
    expect(parseTransaction({ ...good, exp: 1_700_000_000_000 })).toEqual(good)
  })

  test('an unopenable cookie (null) yields no transaction', () => {
    expect(parseTransaction(null)).toBeNull()
  })

  test.each(['state', 'nonce', 'codeVerifier'] as const)(
    'refuses a %s that is missing, empty, or not a string',
    (field) => {
      const missing: Record<string, unknown> = { ...good }
      delete missing[field]
      expect(parseTransaction(missing)).toBeNull()
      // Empty string matters as much as absent: exchangeCode rejects `nonce === ''` outright,
      // so a transaction carrying one must never reach it in the first place.
      expect(parseTransaction({ ...good, [field]: '' })).toBeNull()
      expect(parseTransaction({ ...good, [field]: 42 })).toBeNull()
      expect(parseTransaction({ ...good, [field]: null })).toBeNull()
      expect(parseTransaction({ ...good, [field]: undefined })).toBeNull()
    },
  )
})
