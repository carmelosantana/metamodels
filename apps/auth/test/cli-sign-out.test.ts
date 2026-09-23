import { afterEach, describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { eq, sql } from 'drizzle-orm'
import { adminApiResource, oidcPayload, user } from '@metamodels/schema'
import { seedUser } from './helpers/db.js'
import {
  approveDevice, authorize, CONSOLE_URL, deviceAuthorization, deviceToken, refreshGrant, startTestOp,
  type CookieJar, type DeviceAuthorization, type TestOp,
} from './helpers/flow.js'

/**
 * The operator procedures that end CLI sign-ins, run against a real OP. Rotating SESSION_SECRET and
 * OIDC_COOKIE_KEYS and deleting `Session` rows ends browser sessions only: a CLI sign-in is an
 * `offline_access` grant whose refresh tokens are opaque `oidc_payload` rows that depend on none of
 * those. These tests run the EXACT statements the docs give operators, read out of the docs, so a
 * doc edit that breaks the statement fails here.
 */

const T = 30_000
const ADMIN = adminApiResource(CONSOLE_URL)
const SCOPE = 'openid offline_access read'
const PASSWORD = 'hunter2hunter2'

const doc = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../../../docs/${name}`, import.meta.url)), 'utf8')

/** The single `DELETE FROM oidc_payload WHERE model IN (… 'RefreshToken', 'Grant') …` statement in a doc, verbatim. */
function statementIn(name: string): string {
  const found = [...doc(name).matchAll(/^\s*(DELETE FROM oidc_payload WHERE model IN \([^)\n]*'RefreshToken', 'Grant'\)[^\n]*;)\s*$/gm)]
  expect(found, `exactly one CLI sign-out statement in docs/${name}`).toHaveLength(1)
  return found[0][1]
}

let op: TestOp | undefined
afterEach(async () => {
  await op?.close()
  op = undefined
})

/** A CLI device login for `email`, approved in a browser; returns the first refresh token. */
async function cliLogin(email: string): Promise<string> {
  const auth = await deviceAuthorization(op!, { scope: SCOPE, resource: ADMIN })
  expect(auth.status).toBe(200)
  await approveDevice(op!, auth.json as unknown as DeviceAuthorization, { email, password: PASSWORD })
  const token = await deviceToken(op!, String(auth.json.device_code), { resource: ADMIN })
  expect(token.status).toBe(200)
  return String(token.json.refresh_token)
}

/** Refreshes as `mm` does; returns the successor on success, or the error code. */
async function refresh(rt: string): Promise<{ ok: true; rt: string } | { ok: false; error: unknown }> {
  const res = await refreshGrant(op!, rt, { resource: ADMIN })
  if (res.status === 200) return { ok: true, rt: String(res.json.refresh_token) }
  expect(res.status).toBe(400)
  return { ok: false, error: res.json.error }
}

async function refreshOk(rt: string): Promise<string> {
  const r = await refresh(rt)
  if (!r.ok) throw new Error(`expected a refresh to succeed, got ${String(r.error)}`)
  return r.rt
}

/** A console sign-in in a fresh browser; returns the browser, which now holds a sign-in service session. */
async function browserSignIn(email: string): Promise<CookieJar> {
  const out = await authorize(op!, { email, password: PASSWORD })
  if (out.kind !== 'redirect') throw new Error(`console sign-in failed: ${out.status}`)
  return out.jar
}

/** True when this browser is signed straight back in to the console, with no password asked. */
async function signsInSilently(jar: CookieJar): Promise<boolean> {
  return (await authorize(op!, { jar })).kind === 'redirect'
}

/** Every `oidc_payload` row whose payload names `accountId`, as `model:id`, sorted. */
async function rowsOf(accountId: string): Promise<string[]> {
  const rows = await op!.db.select({ model: oidcPayload.model, id: oidcPayload.id }).from(oidcPayload)
    .where(sql`${oidcPayload.payload}->>'accountId' = ${accountId}`)
  return rows.map((r) => `${r.model}:${r.id}`).sort()
}

const modelsIn = (rows: string[]) => new Set(rows.map((r) => r.slice(0, r.indexOf(':'))))

describe('ending CLI sign-ins', () => {
  test('DEPLOY.md: the statement in "Forcing everyone to sign in again" ends every CLI refresh chain', async () => {
    const everyone = statementIn('DEPLOY.md')
    op = await startTestOp()
    await seedUser(op.db, { email: 'a@x.io', password: PASSWORD })
    await seedUser(op.db, { email: 'b@x.io', password: PASSWORD })
    // Anchor: both chains refresh before the statement runs, so what fails afterwards is its doing.
    const a = await refreshOk(await cliLogin('a@x.io'))
    const b = await refreshOk(await cliLogin('b@x.io'))

    // Access tokens for the admin API are JWTs verified offline by the console and never stored,
    // so there is nothing of theirs to delete: they run out their own lifetime (1 h).
    const models = (await op.db.select({ model: oidcPayload.model }).from(oidcPayload)).map((r) => r.model)
    expect(models).not.toContain('AccessToken')
    expect(models).toContain('RefreshToken')
    expect(models).toContain('Grant')

    await op.db.execute(sql.raw(everyone))

    expect(await refresh(a)).toEqual({ ok: false, error: 'invalid_grant' })
    expect(await refresh(b)).toEqual({ ok: false, error: 'invalid_grant' })
  }, T)

  test('admin-api.md: deactivating a user stops their refreshes at once, but reactivating revives every chain', async () => {
    op = await startTestOp()
    const id = await seedUser(op.db, { email: 'a@x.io', password: PASSWORD })
    const lost = await refreshOk(await cliLogin('a@x.io'))
    const kept = await refreshOk(await cliLogin('a@x.io'))
    const browser = await browserSignIn('a@x.io')

    await op.db.update(user).set({ status: 'deactivated' }).where(eq(user.id, id))
    expect(await refresh(lost)).toEqual({ ok: false, error: 'invalid_grant' })
    expect(await refresh(kept)).toEqual({ ok: false, error: 'invalid_grant' })
    expect(await signsInSilently(browser)).toBe(false)

    // The refused refresh did not use the token up: the account check fails before rotation. So a
    // chain whose holder has kept a copy of it (a thief does not run `mm`) works again the moment
    // the user is reactivated. That is why the doc deletes the user's chains before reactivating.
    await op.db.update(user).set({ status: 'active' }).where(eq(user.id, id))
    await refreshOk(lost)
    // The same holds for the browser's sign-in service session: its row outlives the deactivation.
    expect(await signsInSilently(browser)).toBe(true)
  }, T)

  test('admin-api.md: the per-user statement ends that user\'s sign-ins and no one else\'s', async () => {
    const perUser = statementIn('admin-api.md')
    expect(perUser).toContain("'<user-id>'")
    op = await startTestOp()
    const id = await seedUser(op.db, { email: 'a@x.io', password: PASSWORD })
    const otherId = await seedUser(op.db, { email: 'b@x.io', password: PASSWORD })
    const lost = await refreshOk(await cliLogin('a@x.io'))
    const kept = await refreshOk(await cliLogin('a@x.io'))
    const other = await refreshOk(await cliLogin('b@x.io'))
    const lostBrowser = await browserSignIn('a@x.io')
    const otherBrowser = await browserSignIn('b@x.io')

    // Anchor: both users hold every kind of row the statement deletes before it runs, so the other
    // user's rows are there to lose: a statement that matched too widely changes them below.
    const otherBefore = await rowsOf(otherId)
    for (const rows of [await rowsOf(id), otherBefore]) {
      for (const model of ['Session', 'RefreshToken', 'Grant']) expect(modelsIn(rows)).toContain(model)
    }

    await op.db.update(user).set({ status: 'deactivated' }).where(eq(user.id, id))
    await op.db.execute(sql.raw(perUser.replace('<user-id>', id)))
    await op.db.update(user).set({ status: 'active' }).where(eq(user.id, id))

    const left = modelsIn(await rowsOf(id))
    for (const model of ['Session', 'RefreshToken', 'Grant']) expect(left).not.toContain(model)
    expect(await rowsOf(otherId)).toEqual(otherBefore)

    expect(await refresh(lost)).toEqual({ ok: false, error: 'invalid_grant' })
    expect(await refresh(kept)).toEqual({ ok: false, error: 'invalid_grant' })
    expect(await signsInSilently(lostBrowser)).toBe(false)
    await refreshOk(other)
    expect(await signsInSilently(otherBrowser)).toBe(true)
    // And the reactivated user can sign in again.
    await refreshOk(await cliLogin('a@x.io'))
  }, T)
})
