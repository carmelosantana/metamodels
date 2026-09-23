import { beforeAll, describe, expect, test } from 'vitest'
import { DrizzleConfigStore } from '../src/config/config-store.js'
import { eq } from 'drizzle-orm'
import * as schema from '@metamodels/schema'
import { seal } from '@metamodels/schema/sealed'
import { makeDb, seedFixture, TEST_RING, testRing, type Fixture, type TestDb } from './helpers/seed.js'

let db: TestDb
let fx: Fixture
let store: DrizzleConfigStore

beforeAll(async () => {
  db = await makeDb()
  fx = await seedFixture(db)
  store = new DrizzleConfigStore(db, TEST_RING)
})

describe('DrizzleConfigStore', () => {
  test('resolves a key by hash with its paddock slugs', async () => {
    const rk = await store.resolveKeyByHash(fx.keyHash)
    expect(rk).not.toBeNull()
    expect(rk!.keyId).toBe(fx.keyId)
    expect(rk!.orgId).toBe(fx.orgId)
    expect(rk!.paddockSlugs).toEqual(['small'])
  })

  test('returns null for an unknown hash', async () => {
    expect(await store.resolveKeyByHash('0'.repeat(64))).toBeNull()
  })

  test('loads a paddock with flock + fence', async () => {
    const p = await store.getPaddockBySlug('small')
    expect(p).not.toBeNull()
    expect(p!.breedId).toBe('ollama')
    expect(p!.flock.baseUrl).toBe('http://fake.ollama')
    expect((p!.fence.constraintJson as { allowedModels: string[] }).allowedModels).toEqual(['llama3.2:1b'])
    expect(p!.fence.rateLimit).toEqual({ windowSec: 60, max: 5 })
  })

  test('returns null for an unknown slug', async () => {
    expect(await store.getPaddockBySlug('nope')).toBeNull()
  })

  test('a flock with no credential resolves with none and no error', async () => {
    const p = await store.getPaddockBySlug('small')
    expect(p!.flock.upstreamAuth).toBeNull()
    expect(p!.upstreamAuthError).toBeUndefined()
  })
})

describe('DrizzleConfigStore — the sealed upstream credential', () => {
  test('opens it, so the proxy holds plaintext only in memory', async () => {
    const db = await makeDb()
    await seedFixture(db, { sealFor: (b) => seal('tok-123', TEST_RING, b) })
    const p = await new DrizzleConfigStore(db, TEST_RING).getPaddockBySlug('small')
    expect(p!.flock.upstreamAuth).toBe('tok-123')
    expect(p!.upstreamAuthError).toBeUndefined()
  })

  test('one it cannot open resolves the paddock with the reason and NO credential, rather than throwing', async () => {
    const db = await makeDb()
    await seedFixture(db, { sealFor: (b) => seal('tok-123', testRing(), b) })
    const p = await new DrizzleConfigStore(db, TEST_RING).getPaddockBySlug('small')
    expect(p!.upstreamAuthError).toBe('unknown-key')
    expect(p!.flock.upstreamAuth).toBeNull()
    expect(JSON.stringify(p)).not.toContain('sealed:v1:')
  })

  test('an envelope copied onto another flock\'s row will not open there — it resolves as tampered', async () => {
    const db = await makeDb()
    const fx = await seedFixture(db, { sealFor: (b) => seal('tok-123', TEST_RING, b) })
    // A second flock in the same org, whose credential an attacker with DB write replaced with fx's.
    const [victim] = await db.insert(schema.flock).values({
      orgId: fx.orgId, breed: 'ollama', name: 'other', baseUrl: 'http://elsewhere',
    }).returning()
    await db.insert(schema.paddock).values({ orgId: fx.orgId, flockId: victim.id, slug: 'other', name: 'Other' })
    const [src] = await db.select().from(schema.flock).where(eq(schema.flock.id, fx.flockId))
    await db.update(schema.flock).set({ upstreamAuthEnc: src.upstreamAuthEnc }).where(eq(schema.flock.id, victim.id))

    const p = await new DrizzleConfigStore(db, TEST_RING).getPaddockBySlug('other')
    expect(p!.upstreamAuthError).toBe('tampered')
    expect(p!.flock.upstreamAuth).toBeNull()
  })
})
