import { describe, expect, test } from 'vitest'
import { adminApiResource, CONSOLE_CLIENT_ID, OPERATOR_SESSION_TTL_MS } from '../src/oidc.js'

describe('shared OIDC identifiers', () => {
  test('the console client id is stable (every console ID token names it as aud)', () => {
    expect(CONSOLE_CLIENT_ID).toBe('metamodels-console')
  })

  test('the admin API resource is the console origin plus /api/admin', () => {
    expect(adminApiResource('https://console.example.test')).toBe('https://console.example.test/api/admin')
  })

  test('an operator session lasts 12 hours (the console and the auth service both use it)', () => {
    expect(OPERATOR_SESSION_TTL_MS).toBe(12 * 60 * 60 * 1000)
  })
})
