import { describe, expect, test } from 'vitest'
import { loadServerConfig } from '../src/server.js'

describe('loadServerConfig', () => {
  test('reads DATABASE_URL and defaults PORT to 8787', () => {
    const cfg = loadServerConfig({ DATABASE_URL: 'postgres://x/y' })
    expect(cfg).toEqual({ databaseUrl: 'postgres://x/y', port: 8787 })
  })

  test('honors PORT when set', () => {
    expect(loadServerConfig({ DATABASE_URL: 'postgres://x/y', PORT: '9000' }).port).toBe(9000)
  })

  test('throws a clear error when DATABASE_URL is missing', () => {
    expect(() => loadServerConfig({})).toThrow(/DATABASE_URL/)
  })

  test('reads REDIS_URL when present', () => {
    const cfg = loadServerConfig({ DATABASE_URL: 'postgres://x/y', REDIS_URL: 'redis://localhost:6379' })
    expect(cfg.redisUrl).toBe('redis://localhost:6379')
  })

  test('redisUrl is undefined when REDIS_URL is absent (in-memory dev mode)', () => {
    expect(loadServerConfig({ DATABASE_URL: 'postgres://x/y' }).redisUrl).toBeUndefined()
  })
})
