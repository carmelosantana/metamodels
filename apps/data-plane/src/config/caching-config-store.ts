import type { ConfigStore } from './config-store.js'
import type { ResolvedKey, ResolvedPaddock } from './types.js'

interface Entry<T> { value: T; expiresAt: number }

/**
 * Memoizing decorator over a ConfigStore for the request hot path. Caches both hits and
 * negative (null) results with a short TTL, and exposes invalidateAll() for pub/sub-driven
 * eviction on config writes. Redis-agnostic — the subscriber (elsewhere) drives invalidation.
 */
export class CachingConfigStore implements ConfigStore {
  private readonly keyCache = new Map<string, Entry<ResolvedKey | null>>()
  private readonly paddockCache = new Map<string, Entry<ResolvedPaddock | null>>()
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly now: () => number

  constructor(
    private readonly inner: ConfigStore,
    opts: { ttlMs?: number; maxEntries?: number; now?: () => number } = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 30_000
    this.maxEntries = opts.maxEntries ?? 10_000
    this.now = opts.now ?? Date.now
  }

  private fresh<T>(entry: Entry<T> | undefined): entry is Entry<T> {
    return entry !== undefined && entry.expiresAt > this.now()
  }

  /**
   * Insert an entry with a FIFO size bound so the cache cannot grow without limit. The TTL is a
   * freshness-check-on-read, not an eviction policy, so unbounded distinct keys (e.g. sprayed bogus
   * auth tokens minting one negative entry each) would otherwise grow the Map until OOM.
   */
  private setBounded<T>(cache: Map<string, Entry<T>>, key: string, entry: Entry<T>): void {
    if (!cache.has(key) && cache.size >= this.maxEntries) {
      const oldest = cache.keys().next().value // Map preserves insertion order → FIFO
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(key, entry)
  }

  async resolveKeyByHash(hash: string): Promise<ResolvedKey | null> {
    const cached = this.keyCache.get(hash)
    if (this.fresh(cached)) return cached.value
    const value = await this.inner.resolveKeyByHash(hash)
    this.setBounded(this.keyCache, hash, { value, expiresAt: this.now() + this.ttlMs })
    return value
  }

  async getPaddockBySlug(slug: string): Promise<ResolvedPaddock | null> {
    const cached = this.paddockCache.get(slug)
    if (this.fresh(cached)) return cached.value
    const value = await this.inner.getPaddockBySlug(slug)
    this.setBounded(this.paddockCache, slug, { value, expiresAt: this.now() + this.ttlMs })
    return value
  }

  /** Flush the entire config cache. Called by the invalidation subscriber on any config write. */
  invalidateAll(): void {
    this.keyCache.clear()
    this.paddockCache.clear()
  }
}
