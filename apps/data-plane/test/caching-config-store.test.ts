import { describe, expect, test } from 'vitest'
import { CachingConfigStore } from '../src/config/caching-config-store.js'
import type { ConfigStore } from '../src/config/config-store.js'
import type { ResolvedKey, ResolvedPaddock } from '../src/config/types.js'

function fakeKey(id: string): ResolvedKey {
  return { keyId: id, orgId: 'o', status: 'active', expiresAt: null, paddockSlugs: ['s'], overrides: null }
}
function fakePaddock(slug: string): ResolvedPaddock {
  return {
    paddockId: 'p', orgId: 'o', slug, status: 'active', breedId: 'ollama',
    flock: { baseUrl: 'http://f', upstreamAuth: null, tlsTrust: false },
    fence: { constraintJson: {}, rateLimit: null, quota: null },
  }
}

class CountingInner implements ConfigStore {
  keyCalls = 0
  paddockCalls = 0
  key: ResolvedKey | null = fakeKey('k1')
  paddock: ResolvedPaddock | null = fakePaddock('small')
  async resolveKeyByHash(): Promise<ResolvedKey | null> { this.keyCalls++; return this.key }
  async getPaddockBySlug(): Promise<ResolvedPaddock | null> { this.paddockCalls++; return this.paddock }
}

describe('CachingConfigStore', () => {
  test('memoizes a key hit — inner hit once for repeated reads', async () => {
    const inner = new CountingInner()
    const c = new CachingConfigStore(inner)
    expect((await c.resolveKeyByHash('h'))!.keyId).toBe('k1')
    await c.resolveKeyByHash('h')
    await c.resolveKeyByHash('h')
    expect(inner.keyCalls).toBe(1)
  })

  test('memoizes distinct hashes and slugs separately', async () => {
    const inner = new CountingInner()
    const c = new CachingConfigStore(inner)
    await c.resolveKeyByHash('a')
    await c.resolveKeyByHash('b')
    expect(inner.keyCalls).toBe(2)
    await c.getPaddockBySlug('x')
    await c.getPaddockBySlug('x')
    expect(inner.paddockCalls).toBe(1)
  })

  test('negative results are cached too (unknown key not re-queried)', async () => {
    const inner = new CountingInner()
    inner.key = null
    const c = new CachingConfigStore(inner)
    expect(await c.resolveKeyByHash('h')).toBeNull()
    expect(await c.resolveKeyByHash('h')).toBeNull()
    expect(inner.keyCalls).toBe(1)
  })

  test('reloads after TTL expiry', async () => {
    const inner = new CountingInner()
    let t = 1000
    const c = new CachingConfigStore(inner, { ttlMs: 100, now: () => t })
    await c.resolveKeyByHash('h')
    t = 1099 // within TTL
    await c.resolveKeyByHash('h')
    expect(inner.keyCalls).toBe(1)
    t = 1101 // past TTL
    await c.resolveKeyByHash('h')
    expect(inner.keyCalls).toBe(2)
  })

  test('invalidateAll clears both caches', async () => {
    const inner = new CountingInner()
    const c = new CachingConfigStore(inner)
    await c.resolveKeyByHash('h')
    await c.getPaddockBySlug('x')
    c.invalidateAll()
    await c.resolveKeyByHash('h')
    await c.getPaddockBySlug('x')
    expect(inner.keyCalls).toBe(2)
    expect(inner.paddockCalls).toBe(2)
  })

  // Tracks inner hits per distinct hash so eviction (a re-fetch of a previously cached hash)
  // is observable, and exposes the live cache Map to assert the size bound holds.
  class PerHashInner implements ConfigStore {
    hashCalls = new Map<string, number>()
    async resolveKeyByHash(hash: string): Promise<ResolvedKey | null> {
      this.hashCalls.set(hash, (this.hashCalls.get(hash) ?? 0) + 1)
      return fakeKey(hash)
    }
    async getPaddockBySlug(slug: string): Promise<ResolvedPaddock | null> {
      return fakePaddock(slug)
    }
  }
  const keyCacheOf = (c: CachingConfigStore): Map<string, unknown> =>
    (c as unknown as { keyCache: Map<string, unknown> }).keyCache

  test('bounds the cache with FIFO eviction — oldest evicted, newest retained', async () => {
    const inner = new PerHashInner()
    const c = new CachingConfigStore(inner, { maxEntries: 2 })
    await c.resolveKeyByHash('a')
    await c.resolveKeyByHash('b')
    await c.resolveKeyByHash('c') // evicts 'a' (oldest)
    expect(keyCacheOf(c).size).toBe(2) // bound never exceeded

    await c.resolveKeyByHash('c') // still cached → no new inner hit
    expect(inner.hashCalls.get('c')).toBe(1)
    await c.resolveKeyByHash('a') // evicted → inner hit again
    expect(inner.hashCalls.get('a')).toBe(2)
    expect(keyCacheOf(c).size).toBe(2)
  })

  test('re-setting an already-present key does not evict a different entry', async () => {
    const inner = new PerHashInner()
    let t = 1000
    const c = new CachingConfigStore(inner, { maxEntries: 2, ttlMs: 100, now: () => t })
    await c.resolveKeyByHash('a') // cached at t=1000, expires 1100
    t = 1050
    await c.resolveKeyByHash('b') // cached at t=1050, expires 1150 — cap now full (2)

    // At t=1120 'a' is stale but 'b' is still fresh. Reloading 'a' re-sets an ALREADY-present
    // key, so the `!cache.has(key)` guard must skip eviction and leave 'b' untouched.
    t = 1120
    await c.resolveKeyByHash('a')
    expect(inner.hashCalls.get('a')).toBe(2) // 'a' was reloaded
    expect(keyCacheOf(c).size).toBe(2) // bound respected, no growth

    // 'b' survived the same-key reload: still a cache hit (inner not hit a second time for 'b').
    await c.resolveKeyByHash('b')
    expect(inner.hashCalls.get('b')).toBe(1)
    expect(keyCacheOf(c).size).toBe(2)
  })
})
