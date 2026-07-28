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
  private readonly now: () => number

  constructor(
    private readonly inner: ConfigStore,
    opts: { ttlMs?: number; now?: () => number } = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 30_000
    this.now = opts.now ?? Date.now
  }

  private fresh<T>(entry: Entry<T> | undefined): entry is Entry<T> {
    return entry !== undefined && entry.expiresAt > this.now()
  }

  async resolveKeyByHash(hash: string): Promise<ResolvedKey | null> {
    const cached = this.keyCache.get(hash)
    if (this.fresh(cached)) return cached.value
    const value = await this.inner.resolveKeyByHash(hash)
    this.keyCache.set(hash, { value, expiresAt: this.now() + this.ttlMs })
    return value
  }

  async getPaddockBySlug(slug: string): Promise<ResolvedPaddock | null> {
    const cached = this.paddockCache.get(slug)
    if (this.fresh(cached)) return cached.value
    const value = await this.inner.getPaddockBySlug(slug)
    this.paddockCache.set(slug, { value, expiresAt: this.now() + this.ttlMs })
    return value
  }

  /** Flush the entire config cache. Called by the invalidation subscriber on any config write. */
  invalidateAll(): void {
    this.keyCache.clear()
    this.paddockCache.clear()
  }
}
