import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '@metamodels/schema'
import { adminApiResource, mcpResource } from '@metamodels/schema'
import { seedOrg, sharedDb } from '../test/db'
import { tokenFixture, type TokenFixture } from './test-token'
import { PREFLIGHT_NO_CAPABILITY, PREFLIGHT_NO_PADDOCK } from './keys-service'
import { MemoryReplayGuard, setReplayGuardForTests } from './replay-guard'
import * as mintRoute from '../app/api/internal/v1/oauth-keys/route'
import * as preflightRoute from '../app/api/internal/v1/oauth-keys/preflight/route'

// Both route modules import `getDb` from this module id; the handlers resolve it per request.
const held = vi.hoisted(() => ({ db: undefined as unknown }))
vi.mock('./db', () => ({ getDb: () => held.db }))
const published = vi.hoisted(() => [] as string[])
vi.mock('./config-publisher', () => ({
  publishConfigInvalidation: async (reason: string) => { published.push(reason) },
}))

let tok: TokenFixture
beforeAll(async () => { tok = await tokenFixture() })
afterAll(async () => {
  await tok.close()
  setReplayGuardForTests(undefined)
})
// A fresh in-memory guard per test, whatever REDIS_URL the worker happens to have.
beforeEach(() => {
  published.length = 0
  setReplayGuardForTests(new MemoryReplayGuard())
})
const testDb = sharedDb()

const DP = 'https://dp.test'
const CLIENT = 'https://client.example.test/cimd.json'
const URL_MINT = 'https://console.test/api/internal/v1/oauth-keys'
const URL_PREFLIGHT = `${URL_MINT}/preflight`

/**
 * One org with the paddock `small`, and a way to add users to it. Paddock slugs are unique across the
 * whole table, so a case that needs several users adds them here rather than building a second world.
 */
async function world() {
  const db = testDb()
  held.db = db
  const o = await seedOrg(db)
  const [f] = await db.insert(schema.flock).values({ orgId: o.id, breed: 'ollama', name: 'f', baseUrl: 'http://f' }).returning()
  await db.insert(schema.paddock).values({ orgId: o.id, flockId: f.id, slug: 'small', name: 'Small' })
  const userIn = async (role = 'member', status = 'active') => (await db.insert(schema.user).values({
    orgId: o.id, email: `${role}-${status}@x.io`, passwordHash: 'scrypt$x$y', role, status,
  }).returning())[0]
  return { db, o, userIn }
}

const claims = (sub: string, over: Record<string, unknown> = {}) => ({
  sub, client_id: CLIENT, client_name: 'Claude', resource: mcpResource(DP, 'small'), grant_id: 'grant-1', ...over,
})
const bearer = (jwt: string) => ({ authorization: `Bearer ${jwt}` })
const mint = (headers: Record<string, string>) => mintRoute.POST(new Request(URL_MINT, { method: 'POST', headers }))
const preflight = (headers: Record<string, string>) => preflightRoute.GET(new Request(URL_PREFLIGHT, { headers }))

describe('POST /api/internal/v1/oauth-keys', () => {
  test('a member\'s approval mints an oauth key, audited as the consent, and invalidates the data plane', async () => {
    const { db, userIn } = await world()
    const u = await userIn()
    const res = await mint(bearer(await tok.mintConsent(claims(u.id))))
    expect(res.status).toBe(200)
    const { key_id } = await res.json() as { key_id: string }
    const [row] = await db.select().from(schema.apiKey).where(eq(schema.apiKey.id, key_id))
    expect(row).toMatchObject({ kind: 'oauth', grantId: 'grant-1', oauthClientId: CLIENT, userId: u.id })
    const [audit] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'key.create'))
    expect(audit.changedBy).toBe(`consent:${CLIENT}:grant-1`)
    expect(published).toEqual(['key.create'])
  })

  test('a second approval rebinds and says so to the data plane', async () => {
    const u = await (await world()).userIn()
    await mint(bearer(await tok.mintConsent(claims(u.id))))
    const res = await mint(bearer(await tok.mintConsent(claims(u.id, { grant_id: 'grant-2' }))))
    expect(res.status).toBe(200)
    expect(published).toEqual(['key.create', 'key.rebind'])
  })

  test('a replayed assertion is 401 and mints nothing more', async () => {
    const { db, userIn } = await world()
    const u = await userIn()
    const jwt = await tok.mintConsent(claims(u.id))
    expect((await mint(bearer(jwt))).status).toBe(200)
    expect((await mint(bearer(jwt))).status).toBe(401)
    expect(await db.select().from(schema.apiKey)).toHaveLength(1)
  })

  test('a viewer is 403, an unknown paddock and a non-MCP resource are 404', async () => {
    const { userIn } = await world()
    const viewer = await userIn('viewer')
    const member = await userIn('member')
    expect((await mint(bearer(await tok.mintConsent(claims(viewer.id))))).status).toBe(403)
    expect((await mint(bearer(await tok.mintConsent(claims(member.id, { resource: mcpResource(DP, 'nope') }))))).status).toBe(404)
    expect((await mint(bearer(await tok.mintConsent(claims(member.id, { resource: adminApiResource('https://console.test') }))))).status).toBe(404)
  })

  test('every bad assertion is the same 401: long-lived, wrong typ, wrong audience, no grant, inactive user', async () => {
    const { userIn } = await world()
    const u = await userIn()
    const bad = [
      await tok.mintConsent(claims(u.id), { lifetimeSeconds: 120 }),
      await tok.mintConsent(claims(u.id), { typ: 'at+jwt' }),
      await tok.mintConsent(claims(u.id), { aud: adminApiResource('https://console.test') }),
      await tok.mintConsent(claims(u.id, { grant_id: undefined })),
      await tok.mint({ sub: u.id }),
      'not-a-jwt',
    ]
    for (const jwt of bad) {
      const res = await mint(bearer(jwt))
      expect(res.status).toBe(401)
      expect(await res.json()).toMatchObject({ detail: 'the consent assertion was rejected' })
    }
    const off = await userIn('member', 'deactivated')
    const res = await mint(bearer(await tok.mintConsent(claims(off.id))))
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ detail: 'the consent assertion was rejected' })
  })

  test('an assertion dated in the future is 401 when its exp is more than 60 s from now', async () => {
    const u = await (await world()).userIn()
    // exp − iat is 30 s, within the limit; exp is 80 s from now, which no fresh assertion can be.
    const res = await mint(bearer(await tok.mintConsent(claims(u.id), { iatOffsetSeconds: 50, lifetimeSeconds: 30 })))
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ detail: 'the consent assertion was rejected' })
  })

  test('Redis unreachable: 503 with Retry-After, nothing minted, nothing published (fail closed)', async () => {
    const { db, userIn } = await world()
    const u = await userIn()
    setReplayGuardForTests({ claimOnce: async () => { throw new Error('Reached the max retries per request limit (which is 1).') } })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await mint(bearer(await tok.mintConsent(claims(u.id))))
      expect(res.status).toBe(503)
      expect(res.headers.get('retry-after')).toBe('5')
      expect(res.headers.get('content-type')).toBe('application/problem+json')
      expect(await res.json()).toMatchObject({ status: 503, detail: 'the consent assertion cannot be checked right now; retry after the Retry-After interval' })
      expect(await db.select().from(schema.apiKey)).toEqual([])
      expect(published).toEqual([])
      expect(err).toHaveBeenCalledWith('[internal] 503, the consent replay guard is unavailable:', 'Error: Reached the max retries per request limit (which is 1).')
    } finally {
      err.mockRestore()
    }
  })

  test('bearer-only, like the admin API: no bearer is 401, a bearer with a session cookie is 400', async () => {
    const u = await (await world()).userIn()
    expect((await mint({})).status).toBe(401)
    expect((await mint({ ...bearer(await tok.mintConsent(claims(u.id))), cookie: 'mm_session=x' })).status).toBe(400)
  })
})

describe('GET /api/internal/v1/oauth-keys/preflight', () => {
  test('answers allowed for a member, with no grant in the assertion and nothing written', async () => {
    const { db, userIn } = await world()
    const u = await userIn()
    const res = await preflight(bearer(await tok.mintConsent(claims(u.id, { grant_id: undefined }))))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ allowed: true, reason: null })
    expect(await db.select().from(schema.apiKey)).toHaveLength(0)
    expect(published).toEqual([])
  })

  test('answers a viewer, and an unknown paddock, with the reason the screen shows', async () => {
    const { userIn } = await world()
    const viewer = await userIn('viewer')
    const member = await userIn('member')
    expect(await (await preflight(bearer(await tok.mintConsent(claims(viewer.id))))).json())
      .toEqual({ allowed: false, reason: PREFLIGHT_NO_CAPABILITY })
    expect(await (await preflight(bearer(await tok.mintConsent(claims(member.id, { resource: mcpResource(DP, 'nope') }))))).json())
      .toEqual({ allowed: false, reason: PREFLIGHT_NO_PADDOCK })
  })

  test('Redis unreachable: 503 with Retry-After, not an answer', async () => {
    const u = await (await world()).userIn()
    setReplayGuardForTests({ claimOnce: async () => { throw new Error('connect ECONNREFUSED') } })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await preflight(bearer(await tok.mintConsent(claims(u.id, { grant_id: undefined }))))
      expect(res.status).toBe(503)
      expect(res.headers.get('retry-after')).toBe('5')
    } finally {
      err.mockRestore()
    }
  })

  test('refuses an access token presented as an assertion', async () => {
    const u = await (await world()).userIn()
    expect((await preflight(bearer(await tok.mint({ sub: u.id })))).status).toBe(401)
  })
})
