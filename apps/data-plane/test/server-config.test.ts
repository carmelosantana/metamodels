import { describe, expect, test } from 'vitest'
import { randomBytes } from 'node:crypto'
import { loadServerConfig } from '../src/server.js'

const KEY = randomBytes(32).toString('base64')
const BASE = { DATABASE_URL: 'postgres://x/y', UPSTREAM_AUTH_KEY: KEY, DATA_PLANE_URL: 'http://dp.test', OIDC_ISSUER: 'http://op.test' }

describe('loadServerConfig', () => {
  test('reads DATABASE_URL and defaults PORT to 8787', () => {
    const cfg = loadServerConfig(BASE)
    expect(cfg).toMatchObject({ databaseUrl: 'postgres://x/y', port: 8787 })
  })

  test('honors PORT when set', () => {
    expect(loadServerConfig({ ...BASE, PORT: '9000' }).port).toBe(9000)
  })

  test('throws a clear error when DATABASE_URL is missing', () => {
    expect(() => loadServerConfig({ ...BASE, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/)
  })

  test('reads REDIS_URL when present', () => {
    const cfg = loadServerConfig({ ...BASE, REDIS_URL: 'redis://localhost:6379' })
    expect(cfg.redisUrl).toBe('redis://localhost:6379')
  })

  test('redisUrl is undefined when REDIS_URL is absent (in-memory dev mode)', () => {
    expect(loadServerConfig(BASE).redisUrl).toBeUndefined()
  })

  test('refuses to boot without the key that opens upstream credentials', () => {
    expect(() => loadServerConfig({ ...BASE, UPSTREAM_AUTH_KEY: undefined })).toThrow(/UPSTREAM_AUTH_KEY/)
  })

  test('loads the keyring, previous keys included', () => {
    const old = randomBytes(32).toString('base64')
    const cfg = loadServerConfig({ ...BASE, UPSTREAM_AUTH_PREVIOUS_KEYS: old })
    expect(cfg.sealKeys.byKid.size).toBe(2)
  })

  test('reads the MCP origins; the JWKS is fetched from the issuer unless OIDC_INTERNAL_URL says otherwise', () => {
    expect(loadServerConfig(BASE)).toMatchObject({ dataPlaneUrl: 'http://dp.test', oidcIssuer: 'http://op.test', oidcInternalUrl: 'http://op.test' })
    expect(loadServerConfig({ ...BASE, OIDC_INTERNAL_URL: 'http://auth:3100' }).oidcInternalUrl).toBe('http://auth:3100')
  })

  test('refuses to boot without DATA_PLANE_URL or OIDC_ISSUER, or with a path in either', () => {
    expect(() => loadServerConfig({ ...BASE, DATA_PLANE_URL: undefined })).toThrow(/DATA_PLANE_URL is required/)
    expect(() => loadServerConfig({ ...BASE, OIDC_ISSUER: undefined })).toThrow(/OIDC_ISSUER is required/)
    expect(() => loadServerConfig({ ...BASE, DATA_PLANE_URL: 'http://dp.test/p' })).toThrow(/DATA_PLANE_URL must be an origin/)
  })
})
