import { describe, expect, test } from 'vitest'
import { insecureHttpAllowed, resolveConsoleUrl, resolveIssuer } from '../src/config.js'

describe('resolveIssuer', () => {
  test('the flag wins over the environment', () => {
    expect(resolveIssuer('https://flag.test', { METAMODELS_ISSUER: 'https://env.test' })).toBe('https://flag.test')
  })
  test('falls back to METAMODELS_ISSUER', () => {
    expect(resolveIssuer(undefined, { METAMODELS_ISSUER: 'https://env.test' })).toBe('https://env.test')
  })
  test('normalises a trailing slash away, so the store key and discovery match the issuer exactly', () => {
    expect(resolveIssuer('https://auth.test:3100/', {})).toBe('https://auth.test:3100')
  })
  test('has no default host: with neither, it says what to set', () => {
    expect(() => resolveIssuer(undefined, {})).toThrow(/--issuer.*METAMODELS_ISSUER/)
    expect(() => resolveIssuer(undefined, { METAMODELS_ISSUER: '' })).toThrow(/METAMODELS_ISSUER/)
  })
  test('refuses anything but an http(s) origin', () => {
    expect(() => resolveIssuer('auth.test', {})).toThrow(/origin/)
    expect(() => resolveIssuer('https://auth.test/oidc', {})).toThrow(/origin/)
    expect(() => resolveIssuer('ftp://auth.test', {})).toThrow(/origin/)
    expect(() => resolveIssuer('https://auth.test?x=1', {})).toThrow(/origin/)
  })
})

describe('resolveConsoleUrl', () => {
  test('the flag wins, then METAMODELS_CONSOLE_URL', () => {
    expect(resolveConsoleUrl('https://c.test', { METAMODELS_CONSOLE_URL: 'https://e.test' })).toBe('https://c.test')
    expect(resolveConsoleUrl(undefined, { METAMODELS_CONSOLE_URL: 'https://e.test/' })).toBe('https://e.test')
  })
  test('has no default host', () => {
    expect(() => resolveConsoleUrl(undefined, {})).toThrow(/--console.*METAMODELS_CONSOLE_URL/)
  })
})

describe('plain http', () => {
  const OPT_IN = /--allow-insecure-http.*METAMODELS_ALLOW_INSECURE_HTTP=1/
  test('is allowed to a loopback host, without an opt-in', () => {
    for (const url of ['http://localhost:3100', 'http://127.0.0.1:3100', 'http://127.8.9.10', 'http://[::1]:3100']) {
      expect(resolveIssuer(url, {})).toBe(new URL(url).origin)
      expect(resolveConsoleUrl(url, {})).toBe(new URL(url).origin)
    }
  })
  test('is refused to any other host, naming the opt-in', () => {
    for (const url of ['http://auth.lan.test:3100', 'http://192.168.1.140', 'http://localhost.lan.test', 'http://[::2]', 'http://128.0.0.1']) {
      expect(() => resolveIssuer(url, {}), url).toThrow(OPT_IN)
      expect(() => resolveConsoleUrl(url, {}), url).toThrow(OPT_IN)
    }
    // https to the same hosts is fine.
    expect(resolveIssuer('https://auth.lan.test:3100', {})).toBe('https://auth.lan.test:3100')
  })
  test('is allowed to any host with the opt-in', () => {
    expect(resolveIssuer('http://auth.lan.test:3100', {}, true)).toBe('http://auth.lan.test:3100')
    expect(resolveConsoleUrl('http://192.168.1.140', {}, true)).toBe('http://192.168.1.140')
  })
  test('the opt-in is the flag, or METAMODELS_ALLOW_INSECURE_HTTP=1', () => {
    expect(insecureHttpAllowed(true, {})).toBe(true)
    expect(insecureHttpAllowed(undefined, { METAMODELS_ALLOW_INSECURE_HTTP: '1' })).toBe(true)
    expect(insecureHttpAllowed(undefined, {})).toBe(false)
    expect(insecureHttpAllowed(undefined, { METAMODELS_ALLOW_INSECURE_HTTP: '' })).toBe(false)
    expect(insecureHttpAllowed(undefined, { METAMODELS_ALLOW_INSECURE_HTTP: '0' })).toBe(false)
  })
})
