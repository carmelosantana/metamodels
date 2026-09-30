import { describe, expect, test } from 'vitest'
import { MemoryReplayGuard, RedisReplayGuard } from './replay-guard'

/** Fakes ioredis `SET key value EX ttl NX`: 'OK' when the key was absent or expired, null otherwise. */
function fakeRedis(now: () => number) {
  const store = new Map<string, number>()
  const calls: unknown[][] = []
  return {
    calls,
    async set(key: string, value: string, ex: 'EX', ttl: number, nx: 'NX'): Promise<string | null> {
      calls.push([key, value, ex, ttl, nx])
      const until = store.get(key)
      if (until !== undefined && until > now()) return null
      store.set(key, now() + ttl * 1000)
      return 'OK'
    },
  }
}

describe('RedisReplayGuard', () => {
  test('claims a jti once with SET NX EX, and refuses the replay', async () => {
    const redis = fakeRedis(() => 0)
    const guard = new RedisReplayGuard(redis)
    expect(await guard.claimOnce('j1', 120)).toBe(true)
    expect(await guard.claimOnce('j1', 120)).toBe(false)
    expect(await guard.claimOnce('j2', 120)).toBe(true)
    expect(redis.calls[0]).toEqual(['mm:consent-jti:j1', '1', 'EX', 120, 'NX'])
  })
})

describe('MemoryReplayGuard', () => {
  test('claims a jti once, and forgets it after the window', async () => {
    const guard = new MemoryReplayGuard()
    expect(await guard.claimOnce('j1', 0.05)).toBe(true)
    expect(await guard.claimOnce('j1', 0.05)).toBe(false)
    await new Promise((r) => setTimeout(r, 80))
    expect(await guard.claimOnce('j1', 0.05)).toBe(true)
  })
})
