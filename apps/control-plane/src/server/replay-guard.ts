/**
 * Refuses a consent assertion's `jti` the second time it is seen (M4 D7). The window only has to
 * outlast the assertion itself (60 s at most), so a short TTL is the whole mechanism.
 */
export interface ReplayGuard {
  /** True the first time `jti` is claimed within `ttlSeconds`, false on every later claim. */
  claimOnce(jti: string, ttlSeconds: number): Promise<boolean>
}

/** Redis `SET NX EX`: atomic across control-plane instances. */
export class RedisReplayGuard implements ReplayGuard {
  constructor(private readonly redis: { set(key: string, value: string, ex: 'EX', ttl: number, nx: 'NX'): Promise<string | null> }) {}
  async claimOnce(jti: string, ttlSeconds: number): Promise<boolean> {
    return (await this.redis.set(`mm:consent-jti:${jti}`, '1', 'EX', ttlSeconds, 'NX')) === 'OK'
  }
}

/**
 * One process's memory. Used only when `REDIS_URL` is unset (single-process development and tests);
 * every compose stack has Redis.
 */
export class MemoryReplayGuard implements ReplayGuard {
  private readonly seen = new Map<string, number>()
  async claimOnce(jti: string, ttlSeconds: number): Promise<boolean> {
    const now = Date.now()
    for (const [k, until] of this.seen) if (until <= now) this.seen.delete(k)
    if (this.seen.has(jti)) return false
    this.seen.set(jti, now + ttlSeconds * 1000)
    return true
  }
}

let singleton: ReplayGuard | undefined

export async function replayGuard(): Promise<ReplayGuard> {
  if (singleton) return singleton
  const url = process.env.REDIS_URL
  if (!url) {
    singleton = new MemoryReplayGuard()
    return singleton
  }
  const { default: Redis } = await import('ioredis')
  const client = new Redis(url)
  client.on('error', (e) => {
    // eslint-disable-next-line no-console
    console.error('[replay-guard] redis connection error:', e)
  })
  singleton = new RedisReplayGuard(client)
  return singleton
}

/** For tests: install a guard, or pass undefined to go back to the lazily built default. */
export function setReplayGuardForTests(g: ReplayGuard | undefined): void {
  singleton = g
}
