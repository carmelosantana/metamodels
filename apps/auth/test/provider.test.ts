import { afterEach, describe, expect, test } from 'vitest'
import { decodeProtectedHeader, jwtVerify } from 'jose'
import { createPrivateKey, generateKeyPairSync } from 'node:crypto'
import { CONSOLE_CLIENT_ID, OPERATOR_SESSION_TTL_MS } from '@metamodels/schema'
import { seedUser } from './helpers/db.js'
import { rsaThumbprint } from '../src/keys.js'
import { authCsp } from '../src/views.js'
import {
  authorize, CONSOLE_URL, type CookieJar, exchangeCode, hiddenFields, opJwks, REDIRECT_URI, send, startTestOp, type TestOp,
} from './helpers/flow.js'

const T = 20_000
let op: TestOp | undefined
afterEach(async () => { await op?.close(); op = undefined })

describe('auth service — discovery and plumbing', () => {
  test('publishes discovery with PKCE S256, RFC 9207 iss, logout, and no dynamic registration', async () => {
    op = await startTestOp()
    const meta = await (await fetch(`${op.issuer}/.well-known/openid-configuration`)).json()
    expect(meta.issuer).toBe(op.issuer)
    expect(meta.code_challenge_methods_supported).toContain('S256')
    expect(meta.authorization_response_iss_parameter_supported).toBe(true)
    expect(meta.end_session_endpoint).toBe(`${op.issuer}/session/end`)
    expect(meta.registration_endpoint).toBeUndefined()
  }, T)

  test('health, stylesheet and security headers are served', async () => {
    op = await startTestOp()
    const health = await fetch(`${op.issuer}/healthz`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ok: true })
    expect(health.headers.get('content-security-policy')).toContain("form-action 'self' http://console.test")
    expect(health.headers.get('x-frame-options')).toBe('DENY')
    const css = await fetch(`${op.issuer}/assets/auth.css`)
    expect(css.status).toBe(200)
    expect(css.headers.get('content-type')).toContain('text/css')
  }, T)
})

describe('auth service — authorization code flow', () => {
  test('a valid login completes the flow and yields an ID token for that user', async () => {
    op = await startTestOp()
    const id = await seedUser(op.db, { email: 'admin@x.io', password: 'hunter2hunter2' })
    const out = await authorize(op, { email: 'admin@x.io', password: 'hunter2hunter2' })
    if (out.kind !== 'redirect') throw new Error(`expected a redirect, got ${out.status}: ${out.body.slice(0, 200)}`)
    expect(out.url.searchParams.get('state')).toBe('state-123')
    expect(out.url.searchParams.get('iss')).toBe(op.issuer)

    const token = await exchangeCode(op, out.url.searchParams.get('code')!, out.verifier)
    expect(token.status).toBe(200)
    const { payload } = await jwtVerify(token.json.id_token as string, await opJwks(op), {
      issuer: op.issuer, audience: CONSOLE_CLIENT_ID, algorithms: ['RS256'],
    })
    expect(payload.sub).toBe(id)
    expect(payload.nonce).toBe('nonce-456')
  }, T)

  test('an authorization code is single-use', async () => {
    op = await startTestOp()
    await seedUser(op.db, { email: 'admin@x.io', password: 'hunter2hunter2' })
    const out = await authorize(op, { email: 'admin@x.io', password: 'hunter2hunter2' })
    if (out.kind !== 'redirect') throw new Error('expected a redirect')
    const code = out.url.searchParams.get('code')!
    expect((await exchangeCode(op, code, out.verifier)).status).toBe(200)
    const replay = await exchangeCode(op, code, out.verifier)
    expect(replay.status).toBe(400)
    expect(replay.json.error).toBe('invalid_grant')
  }, T)

  test('a wrong password and an unknown email get the same generic error', async () => {
    op = await startTestOp()
    await seedUser(op.db, { email: 'admin@x.io', password: 'hunter2hunter2' })
    for (const [email, password] of [['admin@x.io', 'wrong'], ['ghost@x.io', 'hunter2hunter2']]) {
      const out = await authorize(op, { email, password })
      if (out.kind !== 'page') throw new Error('expected the login page again')
      expect(out.status).toBe(401)
      expect(out.body).toContain('Invalid email or password.')
    }
  }, T)

  test('a deactivated account is told so', async () => {
    op = await startTestOp()
    await seedUser(op.db, { email: 'gone@x.io', password: 'hunter2hunter2', status: 'deactivated' })
    const out = await authorize(op, { email: 'gone@x.io', password: 'hunter2hunter2' })
    if (out.kind !== 'page') throw new Error('expected the login page again')
    expect(out.body).toContain('This account is deactivated.')
  }, T)

  test('the OP session cookie expires no later than the console session (12 hours)', async () => {
    op = await startTestOp()
    await seedUser(op.db, { email: 'admin@x.io', password: 'hunter2hunter2' })
    const before = Date.now()
    const out = await authorize(op, { email: 'admin@x.io', password: 'hunter2hunter2' })
    if (out.kind !== 'redirect') throw new Error('expected a redirect')
    const lines = out.jar.setCookieLines.filter((l) => /^_session=/.test(l))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      const expires = /;\s*expires=([^;]+)/i.exec(line)?.[1]
      const maxAge = /;\s*max-age=(\d+)/i.exec(line)?.[1]
      expect(expires ?? maxAge).toBeDefined()
      if (expires) expect(Date.parse(expires)).toBeLessThanOrEqual(before + OPERATOR_SESSION_TTL_MS + 60_000)
      if (maxAge) expect(Number(maxAge) * 1000).toBeLessThanOrEqual(OPERATOR_SESSION_TTL_MS)
    }
  }, T)

  test('prompt=login shows the login form even when the browser already has an OP session', async () => {
    op = await startTestOp()
    await seedUser(op.db, { email: 'admin@x.io', password: 'hunter2hunter2' })
    const first = await authorize(op, { email: 'admin@x.io', password: 'hunter2hunter2' })
    if (first.kind !== 'redirect') throw new Error('expected a redirect')

    // Control: the same browser is signed in silently without prompt=login.
    const silent = await authorize(op, { jar: first.jar })
    expect(silent.kind).toBe('redirect')
    if (silent.kind === 'redirect') expect(silent.url.searchParams.get('code')).toBeTruthy()

    const forced = await authorize(op, { jar: first.jar, extra: { prompt: 'login', login_hint: 'invitee@x.io' } })
    if (forced.kind !== 'page') throw new Error(`expected the login form, got a redirect to ${forced.url.href}`)
    expect(forced.status).toBe(200)
    expect(forced.body).toContain('<form method="post"')
    expect(forced.body).toContain('value="invitee@x.io"')
  }, T)

  test('login_hint pre-fills the email field', async () => {
    op = await startTestOp()
    const out = await authorize(op, { extra: { login_hint: 'hint@x.io' } })
    if (out.kind !== 'page') throw new Error('expected the login page')
    expect(out.status).toBe(200)
    expect(out.body).toContain('value="hint@x.io"')
  }, T)

  test('PKCE is mandatory, even for the confidential console client', async () => {
    op = await startTestOp()
    const out = await authorize(op, { pkce: false })
    if (out.kind !== 'redirect') throw new Error('expected an error redirect to the client')
    expect(out.url.searchParams.get('error')).toBe('invalid_request')
  }, T)

  test('an unregistered redirect_uri is never redirected to', async () => {
    op = await startTestOp()
    const out = await authorize(op, { redirectUri: 'http://evil.test/cb' })
    expect(out.kind).toBe('page')
    if (out.kind === 'page') expect(out.status).toBe(400)
  }, T)

  test('five failures lock out an address; another address is unaffected', async () => {
    op = await startTestOp()
    await seedUser(op.db, { email: 'admin@x.io', password: 'hunter2hunter2' })
    const first = await authorize(op)
    if (first.kind !== 'page') throw new Error('expected the login page')
    const action = new URL(/action="([^"]+)"/.exec(first.body)![1], op.issuer).href
    const post = (password: string, ip: string) => send(first.jar, action, {
      method: 'POST',
      headers: { 'x-forwarded-for': ip, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'admin@x.io', password }).toString(),
    })
    for (let i = 0; i < 5; i++) expect((await post('wrong', '203.0.113.7')).status).toBe(401)
    expect((await post('hunter2hunter2', '203.0.113.7')).status).toBe(429)
    expect((await post('hunter2hunter2', '198.51.100.2')).status).toBe(303)
  }, T)

  test('a third-party client is refused at consent instead of being silently granted', async () => {
    op = await startTestOp({
      extraClients: [{
        client_id: 'third-party',
        client_secret: 'third-party-secret-0123',
        redirect_uris: ['http://third.test/cb'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      }],
    })
    await seedUser(op.db, { email: 'admin@x.io', password: 'hunter2hunter2' })
    const out = await authorize(op, {
      clientId: 'third-party', redirectUri: 'http://third.test/cb', email: 'admin@x.io', password: 'hunter2hunter2',
    })
    if (out.kind !== 'redirect') throw new Error('expected an error redirect to the client')
    expect(out.url.searchParams.get('error')).toBe('access_denied')
    expect(out.url.searchParams.get('code')).toBeNull()
  }, T)
})

// The console's invite sign-in (`login_hint` + `prompt=login`) in a browser whose OP session is
// another account's. oidc-provider ends that session first, through a logout step on
// `GET /auth/:uid` that it sends as an auto-submitting script page, which our CSP blocks.
describe('auth service — invite sign-in while another account is signed in', () => {
  const A = { email: 'admin@x.io', password: 'hunter2hunter2' }
  const B = { email: 'invitee@x.io', password: 'invitee-pass-123' }
  const form = { 'content-type': 'application/x-www-form-urlencoded' }

  /** A's browser, then an invite sign-in for B in it: the page the resume after B's login ends on. */
  async function inviteSignIn() {
    op = await startTestOp()
    const idA = await seedUser(op.db, A)
    const idB = await seedUser(op.db, B)
    const first = await authorize(op, A)
    if (first.kind !== 'redirect') throw new Error(`A's sign-in failed: ${first.status}`)
    const out = await authorize(op, { jar: first.jar, ...B, extra: { prompt: 'login', login_hint: B.email } })
    if (out.kind !== 'page') throw new Error(`expected the switch-account step, got a redirect to ${out.url.href}`)
    return { idA, idB, out }
  }

  /** Press the page's button: post its form, then follow redirects to the console's callback. */
  async function pressContinue(jar: CookieJar, body: string, fields: Record<string, string>) {
    const action = /<form id="op\.switchAccountForm" method="post" action="([^"]+)">/.exec(body)![1]
    let res = await send(jar, new URL(action, op!.issuer).href, {
      method: 'POST', headers: form, body: new URLSearchParams(fields).toString(),
    })
    for (let hop = 0; hop < 12 && res.status >= 300 && res.status < 400; hop++) {
      const next = new URL(res.headers.get('location')!, op!.issuer)
      if (next.href.startsWith(REDIRECT_URI)) return { status: res.status, callback: next }
      res = await send(jar, next.href)
    }
    return { status: res.status, callback: undefined }
  }

  test('shows a page with a visible button, not a blank script page, under the unchanged CSP', async () => {
    const { out } = await inviteSignIn()
    expect(out.status).toBe(200)
    expect(out.body).toContain('<h1>Switch account?</h1>')
    expect(out.body).toContain('<link rel="stylesheet" href="/assets/auth.css">')
    expect(out.body).toMatch(/<button[^>]* type="submit" form="op\.switchAccountForm">Continue<\/button>/)
    expect(out.body).not.toMatch(/<script|<noscript|\son[a-z]+=/i)
    expect(out.csp).toBe(authCsp([CONSOLE_URL]))
    expect(out.csp).not.toMatch(/script-src|unsafe-inline/)
  }, T)

  test('Continue ends A\'s session and completes the sign-in as B', async () => {
    const { idA, idB, out } = await inviteSignIn()
    const fields = hiddenFields(out.body)
    expect(fields.logout).toBe('yes')
    expect(fields.xsrf).toBeTruthy()

    const done = await pressContinue(out.jar, out.body, fields)
    if (!done.callback) throw new Error(`expected a redirect to the console, got ${done.status}`)
    expect(done.callback.searchParams.get('state')).toBe('state-123')
    const tokens = await exchangeCode(op!, done.callback.searchParams.get('code')!, out.verifier)
    expect(tokens.status).toBe(200)
    const { payload } = await jwtVerify(tokens.json.id_token as string, await opJwks(op!), { issuer: op!.issuer })
    expect(payload.sub).toBe(idB)
    expect(payload.sub).not.toBe(idA)
  }, T)

  test('the same POST without the xsrf field is refused, and A stays signed in', async () => {
    const { idA, out } = await inviteSignIn()
    const done = await pressContinue(out.jar, out.body, { logout: 'yes' })
    expect(done.status).toBe(400)
    expect(done.callback).toBeUndefined()

    // A's OP session was not ended: this browser still signs the console in silently as A.
    const silent = await authorize(op!, { jar: out.jar })
    if (silent.kind !== 'redirect') throw new Error(`expected a silent sign-in, got ${silent.status}`)
    const tokens = await exchangeCode(op!, silent.url.searchParams.get('code')!, silent.verifier)
    expect((await jwtVerify(tokens.json.id_token as string, await opJwks(op!), { issuer: op!.issuer })).payload.sub).toBe(idA)
  }, T)
})

describe('auth service — signing-key rotation overlap', () => {
  const rsaPem = () =>
    generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  const kidOf = (pem: string) => rsaThumbprint(createPrivateKey(pem).export({ format: 'jwk' }) as { e: string; n: string })

  test('the OP publishes a previous key for verification but keeps signing with the current one', async () => {
    const currentPem = rsaPem()
    const previousPem = rsaPem()
    op = await startTestOp({ signingKeyPem: currentPem, previousSigningKeyPems: [previousPem] })

    // Both keys are published, signer first.
    const jwks = (await (await fetch(`${op.issuer}/jwks`)).json()) as { keys: { kid: string }[] }
    expect(jwks.keys.map((k) => k.kid)).toEqual([kidOf(currentPem), kidOf(previousPem)])

    // And a real token exchange is signed by the *current* key, never the retired one — this is
    // what makes the ordering above load-bearing rather than cosmetic.
    const id = await seedUser(op.db, { email: 'admin@x.io', password: 'hunter2hunter2' })
    const out = await authorize(op, { email: 'admin@x.io', password: 'hunter2hunter2' })
    if (out.kind !== 'redirect') throw new Error(`expected a redirect, got ${out.status}`)
    const token = await exchangeCode(op, out.url.searchParams.get('code')!, out.verifier)
    expect(token.status).toBe(200)
    const idToken = token.json.id_token as string
    expect(decodeProtectedHeader(idToken).kid).toBe(kidOf(currentPem))
    expect(decodeProtectedHeader(idToken).kid).not.toBe(kidOf(previousPem))
    // The published set still verifies it, so the previous key's presence breaks nothing.
    const { payload } = await jwtVerify(idToken, await opJwks(op), {
      issuer: op.issuer, audience: CONSOLE_CLIENT_ID, algorithms: ['RS256'],
    })
    expect(payload.sub).toBe(id)
  }, T)
})
