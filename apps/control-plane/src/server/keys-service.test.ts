import { describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '@metamodels/schema'
import { freshDb, seedOrg, type TestDb } from '../test/db'
import { listKeys, createKey, revokeKey, NotFoundError } from './keys-service'
import { DEFAULT_LIMIT, encodeCursor } from './page'
import { ForbiddenError, type Actor } from '../auth/authorize'

async function actorFor(db: TestDb, role: Actor['role']): Promise<Actor> {
  const o = await seedOrg(db)
  return { id: 'u1', orgId: o.id, email: `${role}@x.io`, role, credential: 'session' }
}

async function paddockIn(db: TestDb, orgId: string, slug: string): Promise<string> {
  const [f] = await db.insert(schema.flock).values({
    orgId, breed: 'ollama', name: 'f', baseUrl: 'http://f',
  }).returning()
  const [p] = await db.insert(schema.paddock).values({
    orgId, flockId: f.id, slug, name: slug,
  }).returning()
  return p.id
}

describe('keys-service createKey', () => {
  test('mints an mm_live_ key; plaintext returned once, only hash+prefix stored', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'member')
    const pid = await paddockIn(db, actor.orgId, 'p1')

    const created = await createKey(db, actor, { name: 'ci', paddockIds: [pid] })
    expect(created.plaintext.startsWith('mm_live_')).toBe(true)
    expect(created.prefix).toBe(created.plaintext.slice(0, 12))

    const [row] = await db.select().from(schema.apiKey).where(eq(schema.apiKey.id, created.id))
    expect(row.orgId).toBe(actor.orgId)
    expect(row.name).toBe('ci')
    expect(row.status).toBe('active')
    expect(row.prefix).toBe(created.prefix)
    // plaintext is NEVER persisted
    expect(row.hash).not.toBe(created.plaintext)
    expect(JSON.stringify(row)).not.toContain(created.plaintext)

    // scope link created
    const links = await db.select().from(schema.keyPaddock).where(eq(schema.keyPaddock.keyId, created.id))
    expect(links.map((l) => l.paddockId)).toEqual([pid])

    // audited without leaking the secret
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'key.create'))
    expect(audits).toHaveLength(1)
    expect(JSON.stringify(audits[0])).not.toContain(created.plaintext)
  })

  test('org consistency: linking a paddock in another org is rejected; nothing is written', async () => {
    const db = await freshDb()
    const mine = await actorFor(db, 'admin')
    const [otherOrg] = await db.insert(schema.org).values({ name: 'other' }).returning()
    const foreignPid = await paddockIn(db, otherOrg.id, 'foreign')

    await expect(createKey(db, mine, { name: 'x', paddockIds: [foreignPid] }))
      .rejects.toThrow(NotFoundError)
    expect(await db.select().from(schema.apiKey)).toHaveLength(0)
    expect(await db.select().from(schema.keyPaddock)).toHaveLength(0)
    expect(await db.select().from(schema.auditLog)).toHaveLength(0)
  })

  test('duplicate paddockIds are de-duplicated into one scope link', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    const pid = await paddockIn(db, actor.orgId, 'p1')
    const created = await createKey(db, actor, { name: 'dup', paddockIds: [pid, pid] })
    const links = await db.select().from(schema.keyPaddock).where(eq(schema.keyPaddock.keyId, created.id))
    expect(links).toHaveLength(1)
  })

  test('optional per-key rate override is validated and persisted', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    const pid = await paddockIn(db, actor.orgId, 'p1')
    const created = await createKey(db, actor, {
      name: 'o', paddockIds: [pid], overrides: { rateLimit: { windowSec: 60, max: 10 } },
    })
    const [row] = await db.select().from(schema.apiKey).where(eq(schema.apiKey.id, created.id))
    expect(row.overrides).toEqual({ rateLimit: { windowSec: 60, max: 10 } })

    await expect(createKey(db, actor, {
      name: 'bad', paddockIds: [pid], overrides: { rateLimit: { windowSec: 0, max: 10 } },
    })).rejects.toThrow()
  })

  test('viewer cannot create a key; nothing is written', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'viewer')
    const pid = await paddockIn(db, actor.orgId, 'p1')
    await expect(createKey(db, actor, { name: 'x', paddockIds: [pid] })).rejects.toThrow(ForbiddenError)
    expect(await db.select().from(schema.apiKey)).toHaveLength(0)
  })

  test('listKeys returns only this org, with prefix/status/paddock slugs, no hash', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    const pid = await paddockIn(db, actor.orgId, 'p1')
    await createKey(db, actor, { name: 'a', paddockIds: [pid] })

    // a key in another org must not appear
    const [otherOrg] = await db.insert(schema.org).values({ name: 'other' }).returning()
    await db.insert(schema.apiKey).values({
      orgId: otherOrg.id, name: 'foreign', prefix: 'mm_live_zzzz', hash: 'deadbeef', status: 'active',
    })

    const rows = await listKeys(db, actor)
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('a')
    expect(rows[0].paddockSlugs).toEqual(['p1'])
    expect(rows[0]).not.toHaveProperty('hash')
  })
})

describe('keys-service revokeKey', () => {
  test('flips status to revoked and audits it', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    const pid = await paddockIn(db, actor.orgId, 'p1')
    const created = await createKey(db, actor, { name: 'k', paddockIds: [pid] })

    await revokeKey(db, actor, created.id)

    const [row] = await db.select().from(schema.apiKey).where(eq(schema.apiKey.id, created.id))
    expect(row.status).toBe('revoked')
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'key.revoke'))
    expect(audits).toHaveLength(1)
    expect(audits[0].target).toBe(`key:${created.id}`)
  })

  // Spec §3. The UPDATE test-and-sets on `status = 'active'`, so the second call matches nothing
  // and returns quietly. It does NOT throw: an already-revoked key is the state the caller asked
  // for, and NotFoundError here would become a 404 on a key the caller just retired.
  test('a second revoke is a silent no-op — still revoked, still exactly one audit row', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    const pid = await paddockIn(db, actor.orgId, 'p1')
    const created = await createKey(db, actor, { name: 'k', paddockIds: [pid] })

    await revokeKey(db, actor, created.id)
    await expect(revokeKey(db, actor, created.id)).resolves.toBeUndefined()

    const [row] = await db.select().from(schema.apiKey).where(eq(schema.apiKey.id, created.id))
    expect(row.status).toBe('revoked')
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'key.revoke'))
    expect(audits).toHaveLength(1)
    // The positive anchor: one row, and it is THIS key's. A count alone would pass against an
    // audit written for something else entirely.
    expect(audits[0].target).toBe(`key:${created.id}`)
  })

  // "Matched no row" now means three different things. Already-revoked is a no-op; the other two
  // are still 404, and must not be blurred into it by the fix.
  test('a key id that never existed is still NotFoundError', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    await expect(revokeKey(db, actor, crypto.randomUUID())).rejects.toThrow(NotFoundError)
    expect(await db.select().from(schema.auditLog)).toHaveLength(0)
  })

  test('cannot revoke a key in another org', async () => {
    const db = await freshDb()
    const mine = await actorFor(db, 'admin')
    const [otherOrg] = await db.insert(schema.org).values({ name: 'other' }).returning()
    const [foreign] = await db.insert(schema.apiKey).values({
      orgId: otherOrg.id, name: 'foreign', prefix: 'mm_live_zzzz', hash: 'dead', status: 'active',
    }).returning()

    await expect(revokeKey(db, mine, foreign.id)).rejects.toThrow(NotFoundError)
    const [still] = await db.select().from(schema.apiKey).where(eq(schema.apiKey.id, foreign.id))
    expect(still.status).toBe('active')
    // And a foreign key that is ALREADY revoked is still 404, not the silent no-op: the org check
    // has to be decided before the status is, or the no-op branch becomes a cross-org oracle.
    await db.update(schema.apiKey).set({ status: 'revoked' }).where(eq(schema.apiKey.id, foreign.id))
    await expect(revokeKey(db, mine, foreign.id)).rejects.toThrow(NotFoundError)
  })

  test('viewer cannot revoke', async () => {
    const db = await freshDb()
    const admin = await actorFor(db, 'admin')
    const pid = await paddockIn(db, admin.orgId, 'p1')
    const created = await createKey(db, admin, { name: 'k', paddockIds: [pid] })
    const viewer: Actor = { ...admin, role: 'viewer', email: 'viewer@x.io' }
    await expect(revokeKey(db, viewer, created.id)).rejects.toThrow(ForbiddenError)
  })
})

describe('keys-service listKeys pagination', () => {
  /** Two paddocks per key: a limit applied to the slug aggregation instead of the key query
   *  would return a short page here, so this test pins the limit to the key query. */
  async function threeKeysEachScopedToTwoPaddocks(db: TestDb, actor: Actor) {
    const a = await paddockIn(db, actor.orgId, 'pa')
    const b = await paddockIn(db, actor.orgId, 'pb')
    const made = []
    for (const n of ['k1', 'k2', 'k3']) made.push(await createKey(db, actor, { name: n, paddockIds: [a, b] }))
    return [...made].sort((x, y) => x.id.localeCompare(y.id))
  }

  test('listKeys paginates by id and a cursor resumes exactly after it', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    const byId = await threeKeysEachScopedToTwoPaddocks(db, actor)

    const first = await listKeys(db, actor, { limit: 2 })
    expect(first.map((k) => k.id)).toEqual([byId[0].id, byId[1].id])
    expect(first[0].paddockSlugs).toEqual(['pa', 'pb'])

    const second = await listKeys(db, actor, { limit: 2, cursor: encodeCursor(byId[1].id) })
    expect(second.map((k) => k.id)).toEqual([byId[2].id])
  })

  test('listKeys without opts still returns every row (the console path is unchanged)', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    // More than one default page of keys, each on two paddocks so the join has twice as many rows
    // as there are keys: a regression that paginated the console's bare call, or limited join rows
    // rather than keys, returns fewer than every key and fails here.
    const a = await paddockIn(db, actor.orgId, 'pa')
    const b = await paddockIn(db, actor.orgId, 'pb')
    const n = DEFAULT_LIMIT + 1
    const keys = await db.insert(schema.apiKey).values(Array.from({ length: n }, (_, i) => ({
      orgId: actor.orgId, name: `k${i}`, prefix: `mm_${i}`, hash: `hash-${i}`,
    }))).returning({ id: schema.apiKey.id })
    await db.insert(schema.keyPaddock).values(keys.flatMap((k) => [{ keyId: k.id, paddockId: a }, { keyId: k.id, paddockId: b }]))
    const all = await listKeys(db, actor)
    expect(all).toHaveLength(n)
    expect(all.every((k) => k.paddockSlugs.length === 2)).toBe(true)
  })
})
