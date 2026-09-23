import { afterEach, describe, expect, test, vi } from 'vitest'
import { jwtVerify } from 'jose'
import { and, eq } from 'drizzle-orm'
import { errors } from 'oidc-provider'
import { adminApiResource, CLI_CLIENT_ID, CONSOLE_CLIENT_ID, oidcPayload } from '@metamodels/schema'
import {
  DEVICE_CODE_TTL, REFRESH_TOKEN_ABSOLUTE_TTL, REFRESH_TOKEN_IDLE_TTL, refreshTokenTtl,
} from '../src/provider.js'
import { seedUser } from './helpers/db.js'
import {
  approveDevice, authorize, CONSOLE_SECRET, CONSOLE_URL, deviceAuthorization, deviceToken, exchangeCode, opJwks,
  refreshGrant, startTestOp, type DeviceAuthorization, type TestOp,
} from './helpers/flow.js'

const T = 30_000
const DAY = 24 * 60 * 60
const ADMIN = adminApiResource(CONSOLE_URL)
const SCOPE = 'openid offline_access read'
let op: TestOp | undefined
afterEach(async () => {
  vi.useRealTimers()
  await op?.close()
  op = undefined
})

/** A signed-in operator approves a CLI device login; returns the CLI's first token response. */
async function cliLogin(scope = SCOPE) {
  op = await startTestOp()
  const id = await seedUser(op.db, { email: 'admin@x.io', password: 'hunter2hunter2' })
  const auth = await deviceAuthorization(op, { scope, resource: ADMIN })
  expect(auth.status).toBe(200)
  const pages = await approveDevice(op, auth.json as unknown as DeviceAuthorization, { email: 'admin@x.io', password: 'hunter2hunter2' })
  const token = await deviceToken(op, String(auth.json.device_code), { resource: ADMIN })
  return { id, auth, pages, token }
}

async function storedRefreshToken(value: string) {
  const [row] = await op!.db.select().from(oidcPayload)
    .where(and(eq(oidcPayload.model, 'RefreshToken'), eq(oidcPayload.id, value)))
  return row?.payload as { exp: number; iat: number; iiat: number } | undefined
}

describe('device authorization endpoint', () => {
  test('is advertised, and answers the CLI with a user code and a verification page on this issuer', async () => {
    op = await startTestOp()
    const meta = await (await fetch(`${op.issuer}/.well-known/openid-configuration`)).json()
    expect(meta.device_authorization_endpoint).toBe(`${op.issuer}/device/auth`)
    expect(meta.grant_types_supported).toContain('urn:ietf:params:oauth:grant-type:device_code')

    const auth = await deviceAuthorization(op, { scope: SCOPE, resource: ADMIN })
    expect(auth.status).toBe(200)
    expect(auth.json.verification_uri).toBe(`${op.issuer}/device`)
    expect(String(auth.json.user_code)).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/)
    expect(auth.json.expires_in).toBe(DEVICE_CODE_TTL)
  }, T)

  test('refuses an undeclared resource at the start, where the declared one is accepted', async () => {
    op = await startTestOp()
    expect((await deviceAuthorization(op, { scope: SCOPE, resource: ADMIN })).status).toBe(200)
    const bad = await deviceAuthorization(op, { scope: SCOPE, resource: 'http://evil.test/api' })
    expect(bad.status).toBe(400)
    expect(bad.json.error).toBe('invalid_target')
  }, T)

  test('refuses the console client, which is not registered for the device grant', async () => {
    op = await startTestOp()
    expect((await deviceAuthorization(op, { scope: SCOPE })).status).toBe(200)
    // Properly authenticated, so the refusal is about the grant type, not the credentials.
    const basic = Buffer.from(`${CONSOLE_CLIENT_ID}:${CONSOLE_SECRET}`).toString('base64')
    const res = await fetch(`${op.issuer}/device/auth`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CONSOLE_CLIENT_ID, scope: SCOPE }).toString(),
    })
    const json = await res.json()
    expect(res.status).toBe(400)
    expect(json.error).toBe('invalid_request')
    expect(json.error_description).toBe('urn:ietf:params:oauth:grant-type:device_code is not allowed for this client')
  }, T)
})

describe('device grant, end to end', () => {
  test('code → confirm page → Approve → sign-in → an admin-API access token for the CLI', async () => {
    op = await startTestOp()
    const id = await seedUser(op.db, { email: 'admin@x.io', password: 'hunter2hunter2' })
    const auth = await deviceAuthorization(op, { scope: SCOPE, resource: ADMIN })
    const da = auth.json as unknown as DeviceAuthorization

    // Before anyone approves, the CLI's poll is told to keep waiting — not refused, not granted.
    const early = await deviceToken(op, da.device_code, { resource: ADMIN })
    expect(early.status).toBe(400)
    expect(early.json.error).toBe('authorization_pending')

    const pages = await approveDevice(op, da, { email: 'admin@x.io', password: 'hunter2hunter2' })
    // The entry and confirm pages are ours, under the auth service's CSP, with no script at all.
    for (const page of [pages.input, pages.confirm]) {
      expect(page.status).toBe(200)
      expect(page.csp).toContain("default-src 'none'")
      expect(page.body).toContain('<link rel="stylesheet" href="/assets/auth.css">')
      expect(page.body).not.toMatch(/<script|\son[a-z]+=/i)
    }
    expect(pages.input.body).toContain('form="op.deviceInputForm">Continue</button>')
    expect(pages.confirm.body).toContain('<strong>MetaModels admin CLI</strong>')
    expect(pages.confirm.body).toContain(`<p class="code">${da.user_code}</p>`)
    expect(pages.confirm.body).toContain('form="op.deviceConfirmForm">Approve</button>')
    // Signed in, and auto-consented as first party — not M1's access_denied branch.
    expect(pages.final.status).toBe(200)
    expect(pages.final.body).toContain('<h1>Signed in</h1>')

    const token = await deviceToken(op, da.device_code, { resource: ADMIN })
    expect(token.status).toBe(200)
    const { payload } = await jwtVerify(token.json.access_token as string, await opJwks(op), {
      issuer: op.issuer, audience: ADMIN, typ: 'at+jwt', algorithms: ['RS256'],
    })
    expect(payload.aud).toBe(ADMIN)
    expect(payload.client_id).toBe(CLI_CLIENT_ID)
    expect(payload.sub).toBe(id)
    expect(payload.scope).toBe('read')
    expect(typeof token.json.refresh_token).toBe('string')

    // The device code is single-use.
    const replay = await deviceToken(op, da.device_code, { resource: ADMIN })
    expect(replay.status).toBe(400)
    expect(replay.json.error).toBe('invalid_grant')
  }, T)

  test('a wrong user code is refused on our own entry page', async () => {
    op = await startTestOp()
    const auth = await deviceAuthorization(op, { scope: SCOPE, resource: ADMIN })
    const da = auth.json as unknown as DeviceAuthorization
    const pages = await approveDevice(op, { ...da, user_code: 'BBBB-BBBB' })
    expect(pages.confirm.body).toContain('That code is not valid.')
    expect(pages.confirm.body).toContain('<link rel="stylesheet" href="/assets/auth.css">')
    expect(pages.confirm.body).not.toContain('Approve</button>')
  }, T)
})

describe('refresh tokens', () => {
  test('rotate: each use issues a new token, and replaying a used one kills the whole chain', async () => {
    const { token } = await cliLogin()
    const first = String(token.json.refresh_token)

    const next = await refreshGrant(op!, first, { resource: ADMIN })
    expect(next.status).toBe(200)
    const second = String(next.json.refresh_token)
    expect(second).not.toBe(first)
    const { payload } = await jwtVerify(next.json.access_token as string, await opJwks(op!), { issuer: op!.issuer, audience: ADMIN })
    expect(payload.aud).toBe(ADMIN)
    expect(payload.client_id).toBe(CLI_CLIENT_ID)

    // Replay of the predecessor: refused, and oidc-provider revokes the whole grant, so the
    // successor dies with it — whoever holds it (reuse detection).
    const replay = await refreshGrant(op!, first, { resource: ADMIN })
    expect(replay.status).toBe(400)
    expect(replay.json.error).toBe('invalid_grant')
    const after = await refreshGrant(op!, second, { resource: ADMIN })
    expect(after.status).toBe(400)
    expect(after.json.error).toBe('invalid_grant')
  }, T)

  test('the console is never issued one, so the rotation policy cannot reach it', async () => {
    const { token } = await cliLogin()
    expect(typeof token.json.refresh_token).toBe('string')

    const out = await authorize(op!, {
      email: 'admin@x.io', password: 'hunter2hunter2', scope: 'openid offline_access', extra: { prompt: 'consent' },
    })
    if (out.kind !== 'redirect') throw new Error(`expected a redirect, got ${out.status}`)
    const consoleToken = await exchangeCode(op!, out.url.searchParams.get('code')!, out.verifier)
    expect(consoleToken.status).toBe(200)
    expect(typeof consoleToken.json.id_token).toBe('string')
    expect(consoleToken.json.refresh_token).toBeUndefined()
  }, T)
})

/**
 * The lifetime bounds (spec §4.4), exercised on the real OP with the clock moved. Only `Date` is
 * faked: oidc-provider's epochTime(), the adapter's expiry filter and jose all read it, while
 * timers and I/O stay real.
 */
describe('refresh-token lifetime', () => {
  const start = () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const t0 = Math.floor(Date.now() / 1000) * 1000
    vi.setSystemTime(t0)
    return { t0s: t0 / 1000, at: (s: number) => vi.setSystemTime(t0 + s * 1000) }
  }

  test('idle window: an unused token dies 30 days after it was issued', async () => {
    const clock = start()
    const { token } = await cliLogin()

    clock.at(29 * DAY)
    const used = await refreshGrant(op!, String(token.json.refresh_token), { resource: ADMIN })
    expect(used.status).toBe(200)
    const renewed = String(used.json.refresh_token)
    expect((await storedRefreshToken(renewed))!.exp).toBe(clock.t0s + 29 * DAY + REFRESH_TOKEN_IDLE_TTL)

    clock.at(29 * DAY + REFRESH_TOKEN_IDLE_TTL + 1)
    const idle = await refreshGrant(op!, renewed, { resource: ADMIN })
    expect(idle.status).toBe(400)
    expect(idle.json.error).toBe('invalid_grant')
  }, T)

  test('absolute cap: a chain kept alive by use still ends 90 days after the first sign-in', async () => {
    const clock = start()
    const { token } = await cliLogin()
    let current = String(token.json.refresh_token)
    expect((await storedRefreshToken(current))!.iiat).toBe(clock.t0s)

    // Used every 25 days — well inside the idle window every time.
    for (const day of [25, 50, 75, 89]) {
      clock.at(day * DAY)
      const res = await refreshGrant(op!, current, { resource: ADMIN })
      expect(res.status, `refresh on day ${day}`).toBe(200)
      current = String(res.json.refresh_token)
      const stored = (await storedRefreshToken(current))!
      // The chain's FIRST issue time rides along every rotation; each token's own iat does not.
      expect(stored.iiat).toBe(clock.t0s)
      expect(stored.iat).toBe(clock.t0s + day * DAY)
      // Idle window while it is the tighter bound, the absolute cap once it is.
      expect(stored.exp).toBe(Math.min(clock.t0s + day * DAY + REFRESH_TOKEN_IDLE_TTL, clock.t0s + REFRESH_TOKEN_ABSOLUTE_TTL))
    }
    // Day 89's token would have lived to day 119 on the idle window alone.
    expect((await storedRefreshToken(current))!.exp).toBe(clock.t0s + 90 * DAY)

    clock.at(REFRESH_TOKEN_ABSOLUTE_TTL + 1)
    const capped = await refreshGrant(op!, current, { resource: ADMIN })
    expect(capped.status).toBe(400)
    expect(capped.json.error).toBe('invalid_grant')

    // It was the refresh token's own cap that fired, not the grant expiring under it.
    const [grant] = await op!.db.select().from(oidcPayload).where(eq(oidcPayload.model, 'Grant'))
    expect((grant.payload as { exp: number }).exp).toBeGreaterThan(clock.t0s + REFRESH_TOKEN_ABSOLUTE_TTL + 1)
  }, 60_000)
})

describe('refreshTokenTtl', () => {
  const now = () => Math.floor(Date.now() / 1000)
  const ttl = (iiat: number | undefined) => refreshTokenTtl({} as never, { iiat } as never)

  test('a young chain gets the full idle window', () => {
    expect(ttl(now())).toBe(REFRESH_TOKEN_IDLE_TTL)
    expect(ttl(now() - 60 * DAY)).toBe(REFRESH_TOKEN_IDLE_TTL)
  })

  test('an old chain gets only what is left of the absolute cap', () => {
    expect(ttl(now() - 80 * DAY)).toBe(10 * DAY)
    expect(ttl(now() - REFRESH_TOKEN_ABSOLUTE_TTL + 1)).toBe(1)
  })

  test('a chain at or past the cap is refused rather than issued a token', () => {
    expect(ttl(now() - REFRESH_TOKEN_ABSOLUTE_TTL + 1)).toBe(1)
    expect(() => ttl(now() - REFRESH_TOKEN_ABSOLUTE_TTL)).toThrow(errors.InvalidGrant)
    expect(() => ttl(now() - REFRESH_TOKEN_ABSOLUTE_TTL - DAY)).toThrow(errors.InvalidGrant)
  })

  test('a token with no chain start is refused, not treated as new', () => {
    expect(ttl(now())).toBe(REFRESH_TOKEN_IDLE_TTL)
    expect(() => ttl(undefined)).toThrow(errors.InvalidGrant)
  })

  test('the bounds are the spec\'s: ~30 days idle, ~90 days absolute', () => {
    expect(REFRESH_TOKEN_IDLE_TTL).toBe(30 * DAY)
    expect(REFRESH_TOKEN_ABSOLUTE_TTL).toBe(90 * DAY)
  })
})
