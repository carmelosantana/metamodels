import { describe, expect, test } from 'vitest'
import { loadAuthConfig } from '../src/config.js'
import { generateKeyPairSync } from 'node:crypto'
import { rsaPemBase64 } from './helpers/keys.js'

/** A second, distinct key, minted at test time. rsaPemBase64() caches per size. */
let second: string | undefined
const secondRsaPemBase64 = () =>
  (second ??= Buffer.from(
    generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
  ).toString('base64'))

function env(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    OIDC_ISSUER: 'https://auth.example.test/',
    CONSOLE_URL: 'https://console.example.test',
    CONSOLE_CLIENT_SECRET: 'console-secret-0123456789',
    OIDC_COOKIE_KEYS: 'cookie-key-new-0123456789, cookie-key-old-0123456789',
    OIDC_SIGNING_KEY: rsaPemBase64(),
    DATABASE_URL: 'postgres://u:p@db:5432/mm',
    ...over,
  }
}

describe('loadAuthConfig', () => {
  test('parses a complete environment', () => {
    const cfg = loadAuthConfig(env())
    expect(cfg.issuer).toBe('https://auth.example.test') // trailing slash stripped
    expect(cfg.consoleUrl).toBe('https://console.example.test')
    expect(cfg.cookieKeys).toEqual(['cookie-key-new-0123456789', 'cookie-key-old-0123456789'])
    expect(cfg.signingKeyPem).toContain('-----BEGIN PRIVATE KEY-----')
    expect(cfg.allowEphemeralKey).toBe(false)
    expect(cfg.port).toBe(3100)
  })

  test.each(['OIDC_ISSUER', 'CONSOLE_URL', 'CONSOLE_CLIENT_SECRET', 'OIDC_COOKIE_KEYS', 'DATABASE_URL'])(
    'names %s when it is missing',
    (name) => {
      expect(() => loadAuthConfig(env({ [name]: undefined }))).toThrow(`${name} is required`)
    },
  )

  test('rejects a non-URL, a path, or a query on the public URLs', () => {
    expect(() => loadAuthConfig(env({ OIDC_ISSUER: 'auth.example.test' }))).toThrow('OIDC_ISSUER must be an absolute http(s) URL')
    expect(() => loadAuthConfig(env({ OIDC_ISSUER: 'https://auth.example.test/oidc' }))).toThrow('OIDC_ISSUER must be an origin')
    expect(() => loadAuthConfig(env({ CONSOLE_URL: 'https://c.example.test/?x=1' }))).toThrow('CONSOLE_URL must be an origin')
  })

  test('enforces secret length on the client secret and every cookie key', () => {
    expect(() => loadAuthConfig(env({ CONSOLE_CLIENT_SECRET: 'short' }))).toThrow('CONSOLE_CLIENT_SECRET must be at least 16 characters')
    expect(() => loadAuthConfig(env({ OIDC_COOKIE_KEYS: 'cookie-key-new-0123456789,short' }))).toThrow('OIDC_COOKIE_KEYS must be at least 16 characters')
  })

  test('refuses to start without a signing key unless ephemeral keys are explicitly allowed', () => {
    expect(() => loadAuthConfig(env({ OIDC_SIGNING_KEY: '' }))).toThrow('OIDC_SIGNING_KEY is required')
    const dev = loadAuthConfig(env({ OIDC_SIGNING_KEY: '', OIDC_ALLOW_EPHEMERAL_KEY: 'true' }))
    expect(dev.signingKeyPem).toBeNull()
    expect(dev.allowEphemeralKey).toBe(true)
  })

  test('rejects a signing key that is not base64 of a PKCS#8 PEM', () => {
    expect(() => loadAuthConfig(env({ OIDC_SIGNING_KEY: Buffer.from('nope').toString('base64') }))).toThrow('PKCS#8')
  })

  test('OIDC_PREVIOUS_SIGNING_KEYS is optional and splits on commas', () => {
    const b64a = rsaPemBase64()
    const b64b = secondRsaPemBase64()
    const cfg = loadAuthConfig(env({ OIDC_PREVIOUS_SIGNING_KEYS: ` ${b64a} , ${b64b} , ` }))
    expect(cfg.previousSigningKeyPems).toHaveLength(2)
    for (const p of cfg.previousSigningKeyPems) expect(p).toContain('-----BEGIN PRIVATE KEY-----')
    expect(cfg.previousSigningKeyPems[0]).not.toBe(cfg.previousSigningKeyPems[1])
    expect(loadAuthConfig(env()).previousSigningKeyPems).toEqual([])
    expect(loadAuthConfig(env({ OIDC_PREVIOUS_SIGNING_KEYS: '' })).previousSigningKeyPems).toEqual([])
  })

  test('a previous key that is not base64 PKCS#8 PEM is rejected at boot', () => {
    // loadAuthConfig IS the boot path (server.ts calls it with process.env before anything else),
    // so a malformed previous key kills the container at startup, not at the first token exchange.
    expect(() => loadAuthConfig(env({ OIDC_PREVIOUS_SIGNING_KEYS: 'bm90LWEta2V5' })))
      .toThrow(/PKCS#8 PEM/)
    // A good signer alongside a bad previous key still fails, and the message names the culprit.
    expect(() => loadAuthConfig(env({ OIDC_PREVIOUS_SIGNING_KEYS: `${rsaPemBase64()},bm90LWEta2V5` })))
      .toThrow(/OIDC_PREVIOUS_SIGNING_KEYS/)
  })

  test('validates AUTH_PORT', () => {
    expect(loadAuthConfig(env({ AUTH_PORT: '4100' })).port).toBe(4100)
    expect(() => loadAuthConfig(env({ AUTH_PORT: 'eighty' }))).toThrow('AUTH_PORT must be a TCP port number')
  })
})
