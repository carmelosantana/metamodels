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
})
