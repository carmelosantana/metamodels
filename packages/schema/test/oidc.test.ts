import { describe, expect, test } from 'vitest'
import { adminApiResource, CLI_CLIENT_ID, CONSOLE_CLIENT_ID, OPERATOR_SESSION_TTL_MS } from '../src/oidc.js'

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
