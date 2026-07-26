import type { RateLimit } from '../config/types.js'

export interface RateLimitResult {
  allowed: boolean
  retryAfterSec: number
}

export interface RateLimiter {
  check(bucketKey: string, limit: RateLimit): Promise<RateLimitResult>
}

export class InMemoryRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, number[]>()
  private readonly now: () => number

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now())
  }

  async check(bucketKey: string, limit: RateLimit): Promise<RateLimitResult> {
    const now = this.now()
    const windowMs = limit.windowSec * 1000
    const cutoff = now - windowMs
    const recent = (this.hits.get(bucketKey) ?? []).filter((t) => t > cutoff)

    if (recent.length < limit.max) {
      recent.push(now)
      this.hits.set(bucketKey, recent)
      return { allowed: true, retryAfterSec: 0 }
    }

    this.hits.set(bucketKey, recent)
    const oldest = recent[0]
    const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000))
    return { allowed: false, retryAfterSec }
  }
}
