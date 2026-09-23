import { describe, expect, test } from 'vitest'
import { randomBytes } from 'node:crypto'
import { loadServerConfig } from '../src/server.js'

const KEY = randomBytes(32).toString('base64')

describe('loadServerConfig', () => {
  test('reads DATABASE_URL and defaults PORT to 8787', () => {
    const cfg = loadServerConfig({ DATABASE_URL: 'postgres://x/y', UPSTREAM_AUTH_KEY: KEY })
    expect(cfg).toMatchObject({ databaseUrl: 'postgres://x/y', port: 8787 })
  })

  test('honors PORT when set', () => {
    expect(loadServerConfig({ DATABASE_URL: 'postgres://x/y', PORT: '9000', UPSTREAM_AUTH_KEY: KEY }).port).toBe(9000)
  })

  test('throws a clear error when DATABASE_URL is missing', () => {
    expect(() => loadServerConfig({})).toThrow(/DATABASE_URL/)
  })

  test('reads REDIS_URL when present', () => {
    const cfg = loadServerConfig({ DATABASE_URL: 'postgres://x/y', REDIS_URL: 'redis://localhost:6379', UPSTREAM_AUTH_KEY: KEY })
    expect(cfg.redisUrl).toBe('redis://localhost:6379')
  })

  test('redisUrl is undefined when REDIS_URL is absent (in-memory dev mode)', () => {
    expect(loadServerConfig({ DATABASE_URL: 'postgres://x/y', UPSTREAM_AUTH_KEY: KEY }).redisUrl).toBeUndefined()
  })

  test('refuses to boot without the key that opens upstream credentials', () => {
    expect(() => loadServerConfig({ DATABASE_URL: 'postgres://x/y' })).toThrow(/UPSTREAM_AUTH_KEY/)
  })

  test('loads the keyring, previous keys included', () => {
    const old = randomBytes(32).toString('base64')
    const cfg = loadServerConfig({ DATABASE_URL: 'postgres://x/y', UPSTREAM_AUTH_KEY: KEY, UPSTREAM_AUTH_PREVIOUS_KEYS: old })
    expect(cfg.sealKeys.byKid.size).toBe(2)
  })
})
