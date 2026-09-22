import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { apiKey, flock, org, paddock, usageRollup, user } from '@metamodels/schema'
import { freshDb, seedOrg, type TestDb } from '../test/db'
import { bearer, tokenFixture, type TokenFixture } from './test-token'
import * as matrix from '../app/api/admin/v1/usage/matrix/route'
import * as daily from '../app/api/admin/v1/usage/daily/route'
import * as topKeysRoute from '../app/api/admin/v1/usage/top-keys/route'

// All three route modules import `getDb` from this very module id, so one mock covers them all. The
// handlers resolve it per request, which is what lets a fresh PGlite be swapped in before each test.
const held = vi.hoisted(() => ({ db: undefined as unknown }))
vi.mock('./db', () => ({ getDb: () => held.db }))

let tok: TokenFixture
beforeAll(async () => { tok = await tokenFixture() })
afterAll(async () => { await tok.close() })

const url = (p: string) => `https://console.test/api/admin/v1${p}`

/** Calls a Route Handler directly — the handler IS the unit; no HTTP server needed. */
const call = (mod: Record<string, unknown>, path: string, token: string) =>
  (mod.GET as (r: Request, c: { params: Promise<Record<string, string>> }) => Promise<Response>)(
    new Request(url(path), { method: 'GET', headers: bearer(token) }),
    { params: Promise.resolve({}) },
  )

// A window wide enough to hold every bucket seeded below, written out rather than computed: a
// range derived from `Date.now()` would make these assertions depend on the wall clock.
const RANGE = 'startBucket=2026-07-22T00&endBucket=2026-07-28T23'

let db: TestDb
let adminUserId: string
let otherOrgId: string
let acme: { keyId: string; paddockId: string }
let beta: { keyId: string; paddockId: string }

async function addUser(orgId: string, email: string, role: string): Promise<string> {
  const [u] = await db.insert(user).values({
    orgId, email, passwordHash: 'unused', role, status: 'active',
  }).returning()
  return u.id
}

async function seedKeyPaddock(orgId: string, keyName: string, slug: string) {
  const [f] = await db.insert(flock).values({
    orgId, breed: 'ollama', name: `f-${slug}`, baseUrl: 'http://upstream:11434',
  }).returning()
  const [p] = await db.insert(paddock).values({ orgId, flockId: f.id, slug, name: slug }).returning()
  const [k] = await db.insert(apiKey).values({
    orgId, name: keyName, prefix: `mm_live_${slug}`, hash: `hash_${slug}`, status: 'active',
  }).returning()
  return { paddockId: p.id, keyId: k.id }
}

async function seedRollup(
  orgId: string, keyId: string, paddockId: string, period: string, dim: string, value: number,
) {
  await db.insert(usageRollup).values({ orgId, keyId, paddockId, period, dim, value })
}

beforeEach(async () => {
  db = await freshDb()
  held.db = db
  const mine = await seedOrg(db)
  const [other] = await db.insert(org).values({ name: 'other' }).returning()
  otherOrgId = other.id
  adminUserId = await addUser(mine.id, 'admin@x.io', 'admin')

  acme = await seedKeyPaddock(mine.id, 'Acme', 'chat')
  beta = await seedKeyPaddock(mine.id, 'Beta', 'art')
  await seedRollup(mine.id, acme.keyId, acme.paddockId, '2026-07-25T10', 'tokens_out', 100)
  await seedRollup(mine.id, acme.keyId, acme.paddockId, '2026-07-26T11', 'tokens_out', 40)
  await seedRollup(mine.id, acme.keyId, acme.paddockId, '2026-07-25T10', 'tokens_in', 7)
  await seedRollup(mine.id, beta.keyId, beta.paddockId, '2026-07-25T10', 'tokens_out', 900)
})

describe('/api/admin/v1/usage/matrix', () => {
  test('GET returns exactly the rows usageMatrix returns, and no Link', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const res = await call(matrix, `/usage/matrix?${RANGE}`, t)
    expect(res.status).toBe(200)
    const rows = await res.json() as { keyName: string; paddockSlug: string; dims: Record<string, number> }[]
    // The service's own pivot and its own ordering (keyName, then paddockSlug) — the route reshapes
    // nothing. `Acme` sorts before `Beta`, so a route that re-sorted or re-keyed fails here.
    expect(rows.map((r) => r.keyName)).toEqual(['Acme', 'Beta'])
    expect(rows[0].paddockSlug).toBe('chat')
    expect(rows[0].dims.tokens_out).toBe(140) // summed across two hour buckets
    expect(rows[0].dims.tokens_in).toBe(7)
    expect(rows[0].dims.jobs).toBe(0)
    // Spec §3: these are reports, not resources. No pagination, so no `Link` — ever, not merely
    // "not on the last page". A copied collection handler would emit one here.
    expect(res.headers.get('Link')).toBeNull()
  })

  test('GET ?keyId= filters, and scopes to the caller\'s org', async () => {
    const foreign = await seedKeyPaddock(otherOrgId, 'Foreign', 'theirs')
    await seedRollup(otherOrgId, foreign.keyId, foreign.paddockId, '2026-07-25T10', 'tokens_out', 5000)

    const t = await tok.mint({ sub: adminUserId })
    const res = await call(matrix, `/usage/matrix?${RANGE}&keyId=${beta.keyId}`, t)
    expect(res.status).toBe(200)
    const rows = await res.json() as { keyName: string; dims: Record<string, number> }[]
    expect(rows.map((r) => r.keyName)).toEqual(['Beta'])
    expect(rows[0].dims.tokens_out).toBe(900)
  })

  // `usage_rollup.key_id` is a uuid column. An unparsed `keyId` reaches Postgres as an invalid uuid
  // literal and throws a driver error `problemForError` cannot map — an opaque 500 for input the
  // caller can fix. Zod in front of the service is the whole point of this route's query schema.
  test('GET with a non-uuid keyId is 422, never an opaque 500', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const res = await call(matrix, `/usage/matrix?${RANGE}&keyId=not-a-uuid`, t)
    expect(res.status).toBe(422)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
  })

  test.each([
    ['a missing startBucket', 'endBucket=2026-07-28T23'],
    ['a missing endBucket', 'startBucket=2026-07-22T00'],
    ['a garbage bucket', 'startBucket=yesterday&endBucket=2026-07-28T23'],
    ['a day with no hour', 'startBucket=2026-07-22&endBucket=2026-07-28T23'],
    ['an impossible hour', 'startBucket=2026-07-22T99&endBucket=2026-07-28T23'],
    ['an impossible month', 'startBucket=2026-13-22T00&endBucket=2026-07-28T23'],
  ])('GET with %s is 422', async (_why, qs) => {
    const t = await tok.mint({ sub: adminUserId })
    const res = await call(matrix, `/usage/matrix?${qs}`, t)
    expect(res.status).toBe(422)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
  })
})

describe('/api/admin/v1/usage/daily', () => {
  test('GET returns the dim\'s series grouped by UTC day', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const res = await call(daily, `/usage/daily?${RANGE}&dim=tokens_out&keyId=${acme.keyId}`, t)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([
      { day: '2026-07-25', value: 100 },
      { day: '2026-07-26', value: 40 },
    ])
    expect(res.headers.get('Link')).toBeNull()
  })

  test('GET without dim is 422', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const res = await call(daily, `/usage/daily?${RANGE}`, t)
    expect(res.status).toBe(422)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
  })

  test('GET with a dim outside METER_DIMS is 422', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const res = await call(daily, `/usage/daily?${RANGE}&dim=dollars`, t)
    expect(res.status).toBe(422)
  })
})

describe('/api/admin/v1/usage/top-keys', () => {
  test('GET orders by value descending and defaults the limit', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const res = await call(topKeysRoute, `/usage/top-keys?${RANGE}&dim=tokens_out`, t)
    expect(res.status).toBe(200)
    const rows = await res.json() as { keyName: string; value: number }[]
    expect(rows.map((r) => [r.keyName, r.value])).toEqual([['Beta', 900], ['Acme', 140]])
    expect(res.headers.get('Link')).toBeNull()
  })

  test('GET ?limit=1 returns only the top key', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const res = await call(topKeysRoute, `/usage/top-keys?${RANGE}&dim=tokens_out&limit=1`, t)
    expect(res.status).toBe(200)
    const rows = await res.json() as { keyName: string }[]
    expect(rows.map((r) => r.keyName)).toEqual(['Beta'])
  })

  // `limit` reaches SQL's LIMIT. Zero is not a smaller page, it is a request for nothing; `abc`
  // and `1e9` are worse. Rejected rather than clamped, exactly as `parsePageOpts` rejects.
  test.each([['limit=0'], ['limit=-1'], ['limit=abc'], ['limit=1000']])(
    'GET with %s is 422', async (qs) => {
      const t = await tok.mint({ sub: adminUserId })
      const res = await call(topKeysRoute, `/usage/top-keys?${RANGE}&dim=tokens_out&${qs}`, t)
      expect(res.status).toBe(422)
      expect(res.headers.get('content-type')).toBe('application/problem+json')
    })
})

describe('usage reports require read', () => {
  test('a token scoped to read alone reaches all three reports', async () => {
    const t = await tok.mint({ sub: adminUserId, scopes: ['read'] })
    for (const [mod, path] of [
      [matrix, `/usage/matrix?${RANGE}`],
      [daily, `/usage/daily?${RANGE}&dim=tokens_out`],
      [topKeysRoute, `/usage/top-keys?${RANGE}&dim=tokens_out`],
    ] as const) {
      const res = await call(mod, path, t)
      expect(res.status).toBe(200)
      // The positive anchor: a 200 alone would also be satisfied by a handler answering `[]` for
      // everyone. These reports have rows for this org, so the read really did reach the service.
      expect((await res.json() as unknown[]).length).toBeGreaterThan(0)
    }
  })

  test('a token with no scopes is 403 naming read, on every report', async () => {
    const t = await tok.mint({ sub: adminUserId, scopes: [] })
    for (const [mod, path] of [
      [matrix, `/usage/matrix?${RANGE}`],
      [daily, `/usage/daily?${RANGE}&dim=tokens_out`],
      [topKeysRoute, `/usage/top-keys?${RANGE}&dim=tokens_out`],
    ] as const) {
      const res = await call(mod, path, t)
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ capability: 'read' })
    }
  })
})
