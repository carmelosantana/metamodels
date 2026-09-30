import { afterEach, describe, expect, test } from 'vitest'
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { jwtVerify } from 'jose'
import * as schema from '@metamodels/schema'
import { mcpResource } from '@metamodels/schema'
import type { ConsentApi, ConsentRequest, Preflight } from '../src/consent-api.js'
import { seedUser, type TestDb } from './helpers/db.js'
import {
  authorize, CIMD_CLIENT_ID, CookieJar, CIMD_REDIRECT_URI, cimdDocument, DATA_PLANE_URL, opJwks, send, startTestOp, type TestOp,
} from './helpers/flow.js'
import { quiet } from './helpers/quiet.js'

const T = 30_000
const EMAIL = 'member@x.io'
const PASSWORD = 'hunter2hunter2'
const RESOURCE = mcpResource(DATA_PLANE_URL, 'small')
/** A web MCP client (the kind claude.ai is): oidc-provider re-prompts a native client for consent on every request, a web one only when its grant falls short. */
const WEB_REDIRECT_URI = 'https://mcp-client.example.test/callback'
let op: TestOp | undefined
let redirectUri = CIMD_REDIRECT_URI
afterEach(async () => { await op?.close(); op = undefined; redirectUri = CIMD_REDIRECT_URI })

/**
 * A stand-in for the control plane's internal routes. `mint` writes the key row the control plane
 * would, so the OP's `extraTokenClaims` finds it exactly as in production.
 */
function fakeControlPlane(opts: { preflight?: Preflight; mint?: 'ok' | 'denied' | 'error' } = {}) {
  const held: { db?: TestDb } = {}
  const calls = { preflight: [] as ConsentRequest[], mint: [] as Array<ConsentRequest & { grantId: string }> }
  const api: ConsentApi = {
    async preflight(r) {
      calls.preflight.push(r)
      return opts.preflight ?? { allowed: true }
    },
    async mint(r) {
      calls.mint.push(r)
      if (opts.mint === 'denied') return { ok: false, kind: 'denied', reason: 'Your role cannot approve apps.' }
      if (opts.mint === 'error') return { ok: false, kind: 'error', detail: 'control plane down' }
      const db = held.db!
      const [u] = await db.select().from(schema.user).where(eq(schema.user.id, r.accountId))
      const [p] = await db.select().from(schema.paddock).where(eq(schema.paddock.slug, 'small'))
      const [k] = await db.insert(schema.apiKey).values({
        orgId: u.orgId, name: 'k', prefix: 'oauth', hash: randomBytes(32).toString('hex'),
        kind: 'oauth', grantId: r.grantId, oauthClientId: r.clientId, userId: u.id,
      }).returning()
      await db.insert(schema.keyPaddock).values({ keyId: k.id, paddockId: p.id })
      return { ok: true, keyId: k.id }
    },
  }
  return { api, calls, held }
}

async function setup(cp: ReturnType<typeof fakeControlPlane>, role = 'member', client: 'native' | 'web' = 'native') {
  const doc = client === 'web' ? cimdDocument({ application_type: 'web', redirect_uris: [WEB_REDIRECT_URI] }) : cimdDocument()
  redirectUri = client === 'web' ? WEB_REDIRECT_URI : CIMD_REDIRECT_URI
  op = await startTestOp({ cimdDocuments: { [CIMD_CLIENT_ID]: doc }, providerOptions: { consentApi: cp.api } })
  cp.held.db = op.db
  const userId = await seedUser(op.db, { email: EMAIL, password: PASSWORD, role })
  const [u] = await op.db.select().from(schema.user).where(eq(schema.user.id, userId))
  const [f] = await op.db.insert(schema.flock).values({ orgId: u.orgId, breed: 'ollama', name: 'f', baseUrl: 'http://f' }).returning()
  await op.db.insert(schema.paddock).values({ orgId: u.orgId, flockId: f.id, slug: 'small', name: 'Small models' })
  return { userId }
}

/** Sign in as the MCP client's user and stop at the consent screen. */
async function consentPage() {
  const out = await authorize(op!, {
    email: EMAIL, password: PASSWORD, clientId: CIMD_CLIENT_ID, redirectUri: redirectUri,
    // What a real MCP client sends: no offline_access and no prompt=consent (ruling R4).
    scope: 'openid mcp', extra: { resource: RESOURCE },
  })
  if (out.kind !== 'page') throw new Error(`expected the consent screen, got a redirect to ${out.url.href}`)
  return { ...out, uid: consentUid(out.body) }
}

/** Post a decision and follow the redirects back to the client. */
async function decide(page: Awaited<ReturnType<typeof consentPage>>, decision: 'approve' | 'deny' | 'close'): Promise<URL> {
  let res = await send(page.jar, `${op!.issuer}/interaction/${page.uid}/consent`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `decision=${decision}`,
  })
  for (let hop = 0; hop < 8; hop++) {
    if (res.status < 300 || res.status >= 400) throw new Error(`expected a redirect, got ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const next = new URL(res.headers.get('location')!, op!.issuer)
    if (next.href.startsWith(redirectUri)) return next
    res = await send(page.jar, next.href)
  }
  throw new Error('too many redirects')
}

/** The same browser (its OP session cookies) authorizing the MCP client again, with no password this time. */
async function reauthorize(jar: CookieJar) {
  return authorize(op!, {
    jar, clientId: CIMD_CLIENT_ID, redirectUri: redirectUri, scope: 'openid mcp', extra: { resource: RESOURCE },
  })
}

function consentUid(body: string): string {
  const uid = /action="\/interaction\/([^/"]+)\/consent"/.exec(body)?.[1]
  if (!uid) throw new Error(`no consent form on the page: ${body.slice(0, 400)}`)
  return uid
}

async function tokenRequest(fields: Record<string, string>) {
  const res = await fetch(`${op!.issuer}/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CIMD_CLIENT_ID, resource: RESOURCE, ...fields }).toString(),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

const grants = async () => op!.db.select().from(schema.oidcPayload).where(eq(schema.oidcPayload.model, 'Grant'))

describe('MCP consent (M4 §4.3)', () => {
  test('the screen shows the client, its host, the redirect host, the paddock and the user; preflight comes first', async () => {
    const cp = fakeControlPlane()
    const { userId } = await setup(cp)
    const page = await consentPage()
    expect(page.status).toBe(200)
    expect(page.body).toContain('Test MCP client')
    expect(page.body).toContain('<strong>mcp-client.example.test</strong>')
    expect(page.body).toContain('127.0.0.1:43210')
    expect(page.body).toContain('Small models')
    expect(page.body).toContain(EMAIL)
    expect(page.body).toContain('prompt=login+consent')
    expect(cp.calls.preflight).toEqual([{ accountId: userId, clientId: CIMD_CLIENT_ID, clientName: 'Test MCP client', resource: RESOURCE }])
    expect(cp.calls.mint).toEqual([])
  }, T)

  test('Approve mints, then grants: a code, then a 15-minute mcp token naming the key, and a refresh token without offline_access', async () => {
    const cp = fakeControlPlane()
    await setup(cp)
    const page = await consentPage()
    const back = await decide(page, 'approve')
    const code = back.searchParams.get('code')
    expect(code, back.href).toBeTruthy()
    expect(cp.calls.mint).toHaveLength(1)
    expect((await grants()).map((g) => g.id)).toEqual([cp.calls.mint[0]!.grantId])

    const token = await tokenRequest({
      grant_type: 'authorization_code', code: code!, redirect_uri: CIMD_REDIRECT_URI, code_verifier: page.verifier,
    })
    expect(token.status, JSON.stringify(token.json)).toBe(200)
    const { payload } = await jwtVerify(token.json.access_token as string, await opJwks(op!), {
      issuer: op!.issuer, audience: RESOURCE, typ: 'at+jwt', algorithms: ['RS256'],
    })
    const [key] = await op!.db.select().from(schema.apiKey)
    expect(payload).toMatchObject({ aud: RESOURCE, scope: 'mcp', client_id: CIMD_CLIENT_ID, mm_kid: key!.id })
    expect(payload.exp! - payload.iat!).toBe(15 * 60)
    // Ruling R4: the request carried neither offline_access nor prompt=consent, as real MCP clients do.
    expect(typeof token.json.refresh_token).toBe('string')
    expect(String(token.json.scope).split(' ')).not.toContain('offline_access')
  }, T)

  test('the refresh token outlives the approving browser\'s OP session (R4: not session-bound)', async () => {
    const cp = fakeControlPlane()
    await setup(cp)
    const page = await consentPage()
    const code = (await decide(page, 'approve')).searchParams.get('code')!
    const first = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: CIMD_REDIRECT_URI, code_verifier: page.verifier })
    // End every OP session, as signing out or the 12-hour expiry would.
    await op!.db.delete(schema.oidcPayload).where(eq(schema.oidcPayload.model, 'Session'))
    const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: first.json.refresh_token as string })
    expect(refreshed.status, JSON.stringify(refreshed.json)).toBe(200)
    expect(typeof refreshed.json.access_token).toBe('string')
  }, T)

  test('a revoked key cannot be refreshed back to life: invalid_grant', async () => {
    const cp = fakeControlPlane()
    await setup(cp)
    const page = await consentPage()
    const code = (await decide(page, 'approve')).searchParams.get('code')!
    const first = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: CIMD_REDIRECT_URI, code_verifier: page.verifier })
    await op!.db.update(schema.apiKey).set({ status: 'revoked' })
    const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: first.json.refresh_token as string })
    expect(refreshed.status).toBe(400)
    expect(refreshed.json.error).toBe('invalid_grant')
  }, T)

  test('a web client re-authorizing in the same browser after the key is revoked shows the consent screen again; Approve mints onto the grant and the code exchanges', async () => {
    const cp = fakeControlPlane()
    await setup(cp, 'member', 'web')
    const page = await consentPage()
    const code = (await decide(page, 'approve')).searchParams.get('code')!
    const first = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: page.verifier })
    expect(first.status, JSON.stringify(first.json)).toBe(200)
    // The operator revokes the key on the Keys page; the OP session in this browser still holds the grant.
    await op!.db.update(schema.apiKey).set({ status: 'revoked' })

    const again = await reauthorize(page.jar)
    if (again.kind !== 'page') throw new Error(`expected the consent screen, got a redirect to ${again.url.href}`)
    expect(again.body).toContain('Small models')
    const back = await decide({ ...again, uid: consentUid(again.body) }, 'approve')
    const code2 = back.searchParams.get('code')
    expect(code2, back.href).toBeTruthy()
    // The session's grant is reused: the second key is minted onto the same grant id.
    expect(cp.calls.mint).toHaveLength(2)
    expect(cp.calls.mint[1]!.grantId).toBe(cp.calls.mint[0]!.grantId)

    const token = await tokenRequest({ grant_type: 'authorization_code', code: code2!, redirect_uri: redirectUri, code_verifier: again.verifier })
    expect(token.status, JSON.stringify(token.json)).toBe(200)
    const { payload } = await jwtVerify(token.json.access_token as string, await opJwks(op!), {
      issuer: op!.issuer, audience: RESOURCE, typ: 'at+jwt', algorithms: ['RS256'],
    })
    const [active] = await op!.db.select().from(schema.apiKey).where(eq(schema.apiKey.status, 'active'))
    expect(payload.mm_kid).toBe(active!.id)
  }, T)

  test('a web client re-authorizing in the same browser while the key is active does not ask again: a code straight back, no second mint', async () => {
    const cp = fakeControlPlane()
    await setup(cp, 'member', 'web')
    const page = await consentPage()
    const code = (await decide(page, 'approve')).searchParams.get('code')!
    const first = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: page.verifier })
    expect(first.status, JSON.stringify(first.json)).toBe(200)

    const again = await reauthorize(page.jar)
    if (again.kind !== 'redirect') throw new Error(`expected a redirect with a code, got the page ${again.body.slice(0, 200)}`)
    const code2 = again.url.searchParams.get('code')
    expect(code2, again.url.href).toBeTruthy()
    expect(cp.calls.mint).toHaveLength(1)
    const token = await tokenRequest({ grant_type: 'authorization_code', code: code2!, redirect_uri: redirectUri, code_verifier: again.verifier })
    expect(token.status, JSON.stringify(token.json)).toBe(200)
  }, T)

  test('Deny ends with access_denied, mints nothing and saves no grant', async () => {
    const cp = fakeControlPlane()
    await setup(cp)
    const back = await decide(await consentPage(), 'deny')
    expect(back.searchParams.get('error')).toBe('access_denied')
    expect(back.searchParams.get('code')).toBeNull()
    expect(cp.calls.mint).toEqual([])
    expect(await grants()).toEqual([])
  }, T)

  test('a viewer sees the refusal and only Close; Close ends with access_denied and the reason', async () => {
    const reason = 'Your role cannot approve apps. Ask an admin or a member of your organization to connect this one.'
    const cp = fakeControlPlane({ preflight: { allowed: false, reason } })
    await setup(cp, 'viewer')
    const page = await consentPage()
    expect(page.body).toContain(reason)
    expect(page.body).not.toContain('value="approve"')
    const back = await decide(page, 'close')
    expect(back.searchParams.get('error')).toBe('access_denied')
    expect(back.searchParams.get('error_description')).toBe(reason)
    expect(cp.calls.mint).toEqual([])
    expect(await grants()).toEqual([])
  }, T)

  test('a mint that fails ends with server_error and no grant, so no grant exists without a key', async () => {
    const err = quiet('error')
    const cp = fakeControlPlane({ mint: 'error' })
    await setup(cp)
    const back = await decide(await consentPage(), 'approve')
    expect(back.searchParams.get('error')).toBe('server_error')
    expect(await grants()).toEqual([])
    expect(await op!.db.select().from(schema.apiKey)).toEqual([])
    expect(err).toHaveBeenCalledWith('[auth] recording an MCP approval failed: control plane down')
  }, T)

  test('a mint refused after a yes from preflight ends with access_denied and the reason', async () => {
    const cp = fakeControlPlane({ mint: 'denied' })
    await setup(cp)
    const back = await decide(await consentPage(), 'approve')
    expect(back.searchParams.get('error')).toBe('access_denied')
    expect(back.searchParams.get('error_description')).toBe('Your role cannot approve apps.')
    expect(await grants()).toEqual([])
  }, T)

  test('a CIMD client asking for no MCP resource is still refused at consent, as in M1', async () => {
    const cp = fakeControlPlane()
    await setup(cp)
    const out = await authorize(op!, {
      email: EMAIL, password: PASSWORD, clientId: CIMD_CLIENT_ID, redirectUri: CIMD_REDIRECT_URI, scope: 'openid',
    })
    if (out.kind !== 'redirect') throw new Error(`expected an error redirect, got the page ${out.body.slice(0, 200)}`)
    expect(out.url.searchParams.get('error')).toBe('access_denied')
    expect(cp.calls.preflight).toEqual([])
  }, T)
})
