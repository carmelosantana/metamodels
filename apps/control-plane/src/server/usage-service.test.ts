import { describe, expect, test } from 'vitest'
import * as schema from '@metamodels/schema'
import { freshDb, seedOrg, type TestDb } from '../test/db'
import { usageMatrix, dailySeries, topKeys, sumDimSince } from './usage-service'
import { type Actor } from '../auth/authorize'

async function actorFor(db: TestDb, role: Actor['role']): Promise<Actor> {
  const o = await seedOrg(db)
  return { id: 'u1', orgId: o.id, email: `${role}@x.io`, role }
}

async function seedKeyPaddock(db: TestDb, orgId: string, keyName: string, slug: string) {
  const [f] = await db.insert(schema.flock).values({ orgId, breed: 'ollama', name: 'f', baseUrl: 'http://f' }).returning()
  const [p] = await db.insert(schema.paddock).values({ orgId, flockId: f.id, slug, name: slug }).returning()
  const [k] = await db.insert(schema.apiKey).values({
    orgId, name: keyName, prefix: `mm_live_${slug}`, hash: `hash_${slug}`, status: 'active',
  }).returning()
  return { paddockId: p.id, keyId: k.id }
}

async function seedRollup(
  db: TestDb, orgId: string, keyId: string, paddockId: string, period: string, dim: string, value: number,
) {
  await db.insert(schema.usageRollup).values({ orgId, keyId, paddockId, period, dim, value })
}

describe('usage-service', () => {
  test('usageMatrix pivots key×paddock rows with all five dims, defaulting missing to 0', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    const { keyId, paddockId } = await seedKeyPaddock(db, actor.orgId, 'Acme', 'chat')
    await seedRollup(db, actor.orgId, keyId, paddockId, '2026-07-25T10', 'tokens_in', 100)
    await seedRollup(db, actor.orgId, keyId, paddockId, '2026-07-25T11', 'tokens_in', 40)
    await seedRollup(db, actor.orgId, keyId, paddockId, '2026-07-25T10', 'tokens_out', 200)

    const rows = await usageMatrix(db, actor, { startBucket: '2026-07-22T00', endBucket: '2026-07-28T23' })
    expect(rows).toHaveLength(1)
    expect(rows[0].keyName).toBe('Acme')
    expect(rows[0].keyPrefix).toBe('mm_live_chat')
    expect(rows[0].paddockSlug).toBe('chat')
    expect(rows[0].dims.tokens_in).toBe(140) // summed across two hour buckets
    expect(rows[0].dims.tokens_out).toBe(200)
    expect(rows[0].dims.jobs).toBe(0)
    expect(rows[0].dims.gpu_ms).toBe(0)
    expect(rows[0].dims.images).toBe(0)
  })

  test('usageMatrix excludes buckets outside the range and other orgs', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    const { keyId, paddockId } = await seedKeyPaddock(db, actor.orgId, 'Acme', 'chat')
    await seedRollup(db, actor.orgId, keyId, paddockId, '2026-07-25T10', 'tokens_in', 100) // in range
    await seedRollup(db, actor.orgId, keyId, paddockId, '2026-07-10T10', 'tokens_in', 999) // before range

    const other = await db.insert(schema.org).values({ name: 'other' }).returning()
    const foreign = await seedKeyPaddock(db, other[0].id, 'Foreign', 'x')
    await seedRollup(db, other[0].id, foreign.keyId, foreign.paddockId, '2026-07-25T10', 'tokens_in', 500)

    const rows = await usageMatrix(db, actor, { startBucket: '2026-07-22T00', endBucket: '2026-07-28T23' })
    expect(rows).toHaveLength(1)
    expect(rows[0].dims.tokens_in).toBe(100)
  })

  test('usageMatrix filters by keyId / paddockId when provided', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    const a = await seedKeyPaddock(db, actor.orgId, 'Acme', 'chat')
    const b = await seedKeyPaddock(db, actor.orgId, 'Beta', 'art')
    await seedRollup(db, actor.orgId, a.keyId, a.paddockId, '2026-07-25T10', 'jobs', 5)
    await seedRollup(db, actor.orgId, b.keyId, b.paddockId, '2026-07-25T10', 'jobs', 9)

    const rows = await usageMatrix(db, actor, { startBucket: '2026-07-22T00', endBucket: '2026-07-28T23', keyId: b.keyId })
    expect(rows).toHaveLength(1)
    expect(rows[0].keyName).toBe('Beta')
    expect(rows[0].dims.jobs).toBe(9)
  })

  test('dailySeries groups a dim by UTC day over the range', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    const { keyId, paddockId } = await seedKeyPaddock(db, actor.orgId, 'Acme', 'chat')
    await seedRollup(db, actor.orgId, keyId, paddockId, '2026-07-25T09', 'tokens_out', 100)
    await seedRollup(db, actor.orgId, keyId, paddockId, '2026-07-25T18', 'tokens_out', 50)
    await seedRollup(db, actor.orgId, keyId, paddockId, '2026-07-26T02', 'tokens_out', 30)
    await seedRollup(db, actor.orgId, keyId, paddockId, '2026-07-26T02', 'tokens_in', 999) // wrong dim, ignored

    const series = await dailySeries(db, actor, { dim: 'tokens_out', startBucket: '2026-07-22T00', endBucket: '2026-07-28T23' })
    expect(series).toEqual([
      { day: '2026-07-25', value: 150 },
      { day: '2026-07-26', value: 30 },
    ])
  })

  test('topKeys ranks keys by summed dim, descending, honoring limit', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    const a = await seedKeyPaddock(db, actor.orgId, 'Acme', 'chat')
    const b = await seedKeyPaddock(db, actor.orgId, 'Beta', 'art')
    await seedRollup(db, actor.orgId, a.keyId, a.paddockId, '2026-07-25T10', 'tokens_out', 100)
    await seedRollup(db, actor.orgId, b.keyId, b.paddockId, '2026-07-25T10', 'tokens_out', 900)
    await seedRollup(db, actor.orgId, b.keyId, b.paddockId, '2026-07-25T11', 'tokens_out', 100)

    const top = await topKeys(db, actor, { dim: 'tokens_out', startBucket: '2026-07-22T00', endBucket: '2026-07-28T23', limit: 5 })
    expect(top.map((k) => [k.keyName, k.value])).toEqual([['Beta', 1000], ['Acme', 100]])
  })

  test('sumDimSince sums one dim from a bucket forward, org-scoped', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    const { keyId, paddockId } = await seedKeyPaddock(db, actor.orgId, 'Acme', 'chat')
    await seedRollup(db, actor.orgId, keyId, paddockId, '2026-07-28T09', 'tokens_out', 10)
    await seedRollup(db, actor.orgId, keyId, paddockId, '2026-07-28T13', 'tokens_out', 5)
    await seedRollup(db, actor.orgId, keyId, paddockId, '2026-07-27T09', 'tokens_out', 999) // before sinceBucket

    const total = await sumDimSince(db, actor, 'tokens_out', '2026-07-28T00')
    expect(total).toBe(15)
  })
})
