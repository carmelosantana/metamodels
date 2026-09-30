import { describe, expect, test } from 'vitest'
import {
  adminApiResource, CLI_CLIENT_ID, CONSENT_ASSERTION_TYP, CONSOLE_CLIENT_ID, internalApiAudience, MCP_SCOPE,
  mcpResource, OPERATOR_SESSION_TTL_MS, parseMcpResource, protectedResourceMetadataUrl, requireOrigin,
} from '../src/oidc.js'
import { KEY_KINDS, PADDOCK_SLUG_RE } from '../src/enums.js'

describe('shared OIDC identifiers', () => {
  test('the console client id is stable (every console ID token names it as aud)', () => {
    expect(CONSOLE_CLIENT_ID).toBe('metamodels-console')
  })

  test('the admin CLI client id is stable (every CLI access token names it as client_id)', () => {
    expect(CLI_CLIENT_ID).toBe('metamodels-cli')
    expect(CLI_CLIENT_ID).not.toBe(CONSOLE_CLIENT_ID)
  })

  test('the admin API resource is the console origin plus /api/admin', () => {
    expect(adminApiResource('https://console.example.test')).toBe('https://console.example.test/api/admin')
  })

  test('an operator session lasts 12 hours (the console and the auth service both use it)', () => {
    expect(OPERATOR_SESSION_TTL_MS).toBe(12 * 60 * 60 * 1000)
  })
})

describe('MCP resource indicators (M4 D2)', () => {
  const DP = 'https://dp.example.test'

  test('one resource per paddock: <DATA_PLANE_URL>/p/<slug>/mcp', () => {
    expect(mcpResource(DP, 'small')).toBe('https://dp.example.test/p/small/mcp')
  })

  test('parseMcpResource inverts mcpResource', () => {
    for (const slug of ['small', 'a', 'gpu-2', 'x'.repeat(64)]) {
      expect(parseMcpResource(DP, mcpResource(DP, slug))).toBe(slug)
    }
  })

  test('parseMcpResource refuses anything that is not exactly one paddock\'s MCP resource', () => {
    for (const uri of [
      'https://dp.example.test/p/small/mcp/',
      'https://dp.example.test/p/small/mcp?x=1',
      'https://dp.example.test/p/small/mcp#f',
      'https://dp.example.test/p//mcp',
      'https://dp.example.test/p/mcp',
      'https://dp.example.test/p/a/b/mcp',
      'https://dp.example.test/p/Small/mcp',
      'https://dp.example.test/p/-small/mcp',
      'https://dp.example.test/p/small',
      'https://other.example.test/p/small/mcp',
      'http://dp.example.test/p/small/mcp',
      `https://dp.example.test/p/${'x'.repeat(65)}/mcp`,
      'https://console.example.test/api/admin',
      '',
    ]) {
      expect(parseMcpResource(DP, uri), uri).toBeNull()
    }
  })

  test('the MCP scope and the consent assertion typ are stable strings', () => {
    expect(MCP_SCOPE).toBe('mcp')
    expect(CONSENT_ASSERTION_TYP).toBe('mm-consent+jwt')
  })

  test('the internal API audience is the console origin plus /api/internal', () => {
    expect(internalApiAudience('https://console.example.test')).toBe('https://console.example.test/api/internal')
  })

  test('RFC 9728 §3.1: the metadata URL puts the well-known segment before the resource path', () => {
    expect(protectedResourceMetadataUrl('https://dp.example.test/p/small/mcp'))
      .toBe('https://dp.example.test/.well-known/oauth-protected-resource/p/small/mcp')
    expect(protectedResourceMetadataUrl('https://console.example.test/api/admin'))
      .toBe('https://console.example.test/.well-known/oauth-protected-resource/api/admin')
    expect(protectedResourceMetadataUrl('https://dp.example.test'))
      .toBe('https://dp.example.test/.well-known/oauth-protected-resource')
  })

  test('key kinds and the paddock slug rule are exported once, for every service', () => {
    expect(KEY_KINDS).toEqual(['live', 'oauth'])
    expect(PADDOCK_SLUG_RE.test('gpu-2')).toBe(true)
    expect(PADDOCK_SLUG_RE.test('Gpu')).toBe(false)
  })
})

describe('requireOrigin', () => {
  test('returns the bare origin, trailing slash stripped', () => {
    expect(requireOrigin('X', 'https://a.test/')).toBe('https://a.test')
  })

  test('names the variable when it is missing or blank', () => {
    expect(() => requireOrigin('DATA_PLANE_URL', undefined)).toThrow('DATA_PLANE_URL is required')
    expect(() => requireOrigin('DATA_PLANE_URL', '  ')).toThrow('DATA_PLANE_URL is required')
  })

  test('refuses a path, a query, a fragment, a non-http scheme and a non-URL', () => {
    for (const v of ['https://a.test/x', 'https://a.test/?q', 'https://a.test/#f', 'ftp://a.test', 'not a url']) {
      expect(() => requireOrigin('X', v), v).toThrow(/^X must be/)
    }
  })
})
