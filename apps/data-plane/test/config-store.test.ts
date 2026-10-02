import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { DrizzleConfigStore, keyExpired } from '../src/config/config-store.js'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import * as schema from '@metamodels/schema'
import { seal } from '@metamodels/schema/sealed'
import { quiet } from './helpers/quiet.js'
import { makeDb, seedFixture, seedOauthKey, TEST_RING, testRing, type Fixture, type TestDb } from './helpers/seed.js'

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
    const err = quiet('error')
    const db = await makeDb()
    await seedFixture(db, { sealFor: (b) => seal('tok-123', testRing(), b) })
    const p = await new DrizzleConfigStore(db, TEST_RING).getPaddockBySlug('small')
    expect(p!.upstreamAuthError).toBe('unknown-key')
    expect(p!.flock.upstreamAuth).toBeNull()
    expect(JSON.stringify(p)).not.toContain('sealed:v1:')
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/^\[config\] flock .+: cannot open sealed value: sealed under key .+, which this keyring does not hold$/))
  })

  test('an envelope copied onto another flock\'s row will not open there — it resolves as tampered', async () => {
    const err = quiet('error')
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
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/^\[config\] flock .+: cannot open sealed value: envelope under key .+ failed authentication for this flock$/))
  })
})

describe('the two key paths (M4 §2)', () => {
  test('resolveKeyById answers an active oauth key, with its client id and paddocks', async () => {
    const db = await makeDb()
    const fx = await seedFixture(db)
    const oauth = await seedOauthKey(db, fx, { clientId: 'https://c.example/client.json' })
    const store = new DrizzleConfigStore(db, TEST_RING)
    expect(await store.resolveKeyById(oauth.keyId)).toMatchObject({
      keyId: oauth.keyId, orgId: fx.orgId, status: 'active', paddockSlugs: ['small'], oauthClientId: 'https://c.example/client.json',
    })
  })

  test('resolveKeyById never answers a live key, a revoked key or a non-uuid', async () => {
    const db = await makeDb()
    const fx = await seedFixture(db)
    const oauth = await seedOauthKey(db, fx, { status: 'revoked' })
    const store = new DrizzleConfigStore(db, TEST_RING)
    expect(await store.resolveKeyById(fx.keyId)).toBeNull()
    expect(await store.resolveKeyById(oauth.keyId)).toBeNull()
    expect(await store.resolveKeyById('not-a-uuid')).toBeNull()
  })

  test('resolveKeyByHash never answers an oauth key, even given its hash', async () => {
    const db = await makeDb()
    const fx = await seedFixture(db)
    const oauth = await seedOauthKey(db, fx)
    const store = new DrizzleConfigStore(db, TEST_RING)
    expect(await store.resolveKeyByHash(oauth.hash)).toBeNull()
    expect((await store.resolveKeyByHash(fx.keyHash))?.keyId).toBe(fx.keyId)
  })

  test('a paddock carries its display name', async () => {
    const db = await makeDb()
    await seedFixture(db)
    expect((await new DrizzleConfigStore(db, TEST_RING).getPaddockBySlug('small'))?.name).toBe('Small models')
  })
})

describe('an expired key costs what an unknown key costs (Kanboard #4558, follow-up ruling F9)', () => {
  /** A store over the same database whose every statement is counted. */
  function counted(db: TestDb) {
    const log: string[] = []
    const counting = drizzle(db.$client, { schema, logger: { logQuery: (query) => { log.push(query) } } })
    return { store: new DrizzleConfigStore(counting, TEST_RING), log }
  }
  const past = () => new Date(Date.now() - 60_000)

  test('resolveKeyByHash: unknown, revoked and expired are each one query and null; a usable key is two', async () => {
    const db = await makeDb()
    const fx = await seedFixture(db)
    const [revoked] = await db.insert(schema.apiKey).values({ orgId: fx.orgId, name: 'r', prefix: 'mm_live_r', hash: 'h-revoked', status: 'revoked' }).returning()
    const [expired] = await db.insert(schema.apiKey).values({ orgId: fx.orgId, name: 'e', prefix: 'mm_live_e', hash: 'h-expired', expiresAt: past() }).returning()
    await db.insert(schema.keyPaddock).values([{ keyId: revoked!.id, paddockId: fx.paddockId }, { keyId: expired!.id, paddockId: fx.paddockId }])
    for (const hash of ['0'.repeat(64), 'h-revoked', 'h-expired']) {
      const { store, log } = counted(db)
      expect(await store.resolveKeyByHash(hash), hash).toBeNull()
      expect(log, hash).toHaveLength(1)
    }
    const { store, log } = counted(db)
    expect((await store.resolveKeyByHash(fx.keyHash))?.keyId).toBe(fx.keyId)
    expect(log).toHaveLength(2)
  })

  test('a key whose expires_at is still ahead resolves', async () => {
    const db = await makeDb()
    const fx = await seedFixture(db)
    await db.update(schema.apiKey).set({ expiresAt: new Date(Date.now() + 60_000) }).where(eq(schema.apiKey.id, fx.keyId))
    expect((await new DrizzleConfigStore(db, TEST_RING).resolveKeyByHash(fx.keyHash))?.keyId).toBe(fx.keyId)
  })

  test('resolveKeyById: unknown, revoked and expired oauth keys are each one query and null', async () => {
    const db = await makeDb()
    const fx = await seedFixture(db)
    const revoked = await seedOauthKey(db, fx, { status: 'revoked' })
    const expired = await seedOauthKey(db, fx)
    await db.update(schema.apiKey).set({ expiresAt: past() }).where(eq(schema.apiKey.id, expired.keyId))
    for (const id of ['00000000-0000-4000-8000-000000000000', revoked.keyId, expired.keyId]) {
      const { store, log } = counted(db)
      expect(await store.resolveKeyById(id), id).toBeNull()
      expect(log, id).toHaveLength(1)
    }
  })
})

// Kanboard #4720: one rule on every side. A key is expired *at* its expires_at, in the store's
// lookup and in the callers' cached-key check alike, so the 1 ms at the boundary is never split.
describe('a key is expired at its expires_at instant (Kanboard #4720)', () => {
  afterEach(() => { vi.useRealTimers() })

  test('keyExpired: null never expires; the instant itself and later are expired; a millisecond before is not', () => {
    const at = new Date('2026-10-02T12:00:00.000Z')
    expect(keyExpired(null, at.getTime())).toBe(false)
    expect(keyExpired(at, at.getTime() - 1)).toBe(false)
    expect(keyExpired(at, at.getTime())).toBe(true)
    expect(keyExpired(at, at.getTime() + 1)).toBe(true)
  })

  test('the store refuses a key at exactly its expires_at, and resolves it a millisecond before', async () => {
    const db = await makeDb()
    const fx = await seedFixture(db)
    const at = new Date(Date.now() + 60_000)
    await db.update(schema.apiKey).set({ expiresAt: at }).where(eq(schema.apiKey.id, fx.keyId))
    const store = new DrizzleConfigStore(db, TEST_RING)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(at.getTime() - 1)
    expect((await store.resolveKeyByHash(fx.keyHash))?.keyId).toBe(fx.keyId)
    vi.setSystemTime(at)
    expect(await store.resolveKeyByHash(fx.keyHash)).toBeNull()
  })
})
