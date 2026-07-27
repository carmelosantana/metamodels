import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'
import type { RateLimit } from '../config/types.js'
import type { RateLimiter, RateLimitResult } from './rate-limiter.js'

// Atomic sliding-window-log over a ZSET (scores = timestamps ms). One round trip,
// one EVAL, so the trim→count→decide→add is indivisible across instances.
// KEYS[1]=bucket  ARGV: 1=now 2=windowMs 3=max 4=unique member id
// returns { allowed(1|0), retryAfterSec }
const SCRIPT = `
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - windowMs)
local count = redis.call('ZCARD', KEYS[1])
if count < max then
  redis.call('ZADD', KEYS[1], now, ARGV[4])
  redis.call('PEXPIRE', KEYS[1], windowMs)
  return {1, 0}
end
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
local retryMs = windowMs
if oldest[2] then retryMs = (tonumber(oldest[2]) + windowMs) - now end
local retrySec = math.ceil(retryMs / 1000)
if retrySec < 1 then retrySec = 1 end
return {0, retrySec}
`

export class RedisRateLimiter implements RateLimiter {
  private readonly now: () => number

  constructor(
    private readonly redis: Redis,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? (() => Date.now())
  }

  async check(bucketKey: string, limit: RateLimit): Promise<RateLimitResult> {
    const now = this.now()
    const res = (await this.redis.eval(
      SCRIPT,
      1,
      `rl:${bucketKey}`,
      String(now),
      String(limit.windowSec * 1000),
      String(limit.max),
      randomUUID(),
    )) as [number, number]
    return { allowed: res[0] === 1, retryAfterSec: res[1] }
  }
}
