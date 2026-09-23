import { describe, expect, test } from 'vitest'
import { resolveConsoleUrl, resolveIssuer } from '../src/config.js'

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
