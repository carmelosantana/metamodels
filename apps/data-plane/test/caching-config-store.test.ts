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
})
