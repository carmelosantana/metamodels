import { createServer, type Socket } from 'node:net'
import Redis from 'ioredis'
import { describe, expect, test } from 'vitest'
import { MemoryReplayGuard, REPLAY_REDIS_OPTIONS, RedisReplayGuard } from './replay-guard'

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

describe('RedisReplayGuard with Redis unreachable (follow-up ruling F3)', () => {
  test('a claim rejects in under 2 s, well inside the OP\'s 5 s call timeout', async () => {
    // Port 1 on loopback: nothing listens, so every connection is refused at once.
    const client = new Redis('redis://127.0.0.1:1', REPLAY_REDIS_OPTIONS)
    client.on('error', () => {})
    try {
      const started = Date.now()
      await expect(new RedisReplayGuard(client).claimOnce('j1', 120)).rejects.toThrow()
      expect(Date.now() - started).toBeLessThan(2_000)
    } finally {
      client.disconnect()
    }
  })

  test('a claim against a host that accepts and never answers settles in about commandTimeout, not never', async () => {
    // A stalled but open socket: the connection succeeds, the ready check and the claim sit unanswered.
    const sockets = new Set<Socket>()
    const server = createServer((s) => { sockets.add(s); s.on('error', () => {}) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    const client = new Redis(`redis://127.0.0.1:${port}`, REPLAY_REDIS_OPTIONS)
    client.on('error', () => {})
    try {
      const started = Date.now()
      const outcome = await Promise.race([
        new RedisReplayGuard(client).claimOnce('j1', 120).then(() => 'resolved', () => 'rejected'),
        new Promise((resolve) => setTimeout(() => resolve('still pending after 5 s'), 5_000)),
      ])
      expect(outcome).toBe('rejected')
      expect(Date.now() - started).toBeLessThan(3_000)
    } finally {
      client.disconnect()
      for (const s of sockets) s.destroy()
      await new Promise((resolve) => server.close(resolve))
    }
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
