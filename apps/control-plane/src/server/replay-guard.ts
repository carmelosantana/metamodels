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

/**
 * The replay guard's ioredis options (follow-up ruling F3). With Redis unreachable, ioredis's defaults
 * (20 retries per command, backoff up to 2 s) hold a claim for about 10.5 s before rejecting, and a
 * host that accepts but never answers holds it forever: both longer than the OP's 5 s call timeout
 * (`apps/auth/src/consent-api.ts` `CALL_TIMEOUT_MS`), so the OP gave up first and the route's answer
 * was never seen. The retry counter is connection-wide and only resets on ready, so in a long outage
 * `maxRetriesPerRequest` alone can still hold a claim for several seconds. `commandTimeout` is the
 * bound: ioredis arms it when the command is sent, offline queue included, so every claim settles
 * within about 2 s. `connectTimeout` bounds each connection attempt. The route turns a rejection into
 * a 503. The offline queue stays on: the client is built lazily and the first claim waits for it.
 */
export const REPLAY_REDIS_OPTIONS = { maxRetriesPerRequest: 1, connectTimeout: 2_000, commandTimeout: 2_000 } as const

let singleton: ReplayGuard | undefined

export async function replayGuard(): Promise<ReplayGuard> {
  if (singleton) return singleton
  const url = process.env.REDIS_URL
  if (!url) {
    singleton = new MemoryReplayGuard()
    return singleton
  }
  const { default: Redis } = await import('ioredis')
  const client = new Redis(url, REPLAY_REDIS_OPTIONS)
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
