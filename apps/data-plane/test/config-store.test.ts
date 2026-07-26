import { beforeAll, describe, expect, test } from 'vitest'
import { DrizzleConfigStore } from '../src/config/config-store.js'
import { makeDb, seedFixture, type Fixture, type TestDb } from './helpers/seed.js'

let db: TestDb
let fx: Fixture
let store: DrizzleConfigStore

beforeAll(async () => {
  db = await makeDb()
  fx = await seedFixture(db)
  store = new DrizzleConfigStore(db)
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
})
