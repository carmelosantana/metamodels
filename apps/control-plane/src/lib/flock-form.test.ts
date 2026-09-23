import { describe, expect, test } from 'vitest'
import { ZodError } from 'zod'
import { ForbiddenError } from '../auth/authorize'
import { CredentialRebindError, NotFoundError } from '../server/flocks-service'
import { flockFormToInput, saveFlockErrorMessage } from './flock-form'
import { saveFlockInput } from './flock-schema'

const form = (fields: Record<string, string>) => {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  return fd
}
const BASE = { breed: 'ollama', name: ' n ', baseUrl: ' http://o ', tlsTrust: 'true' }

describe('flockFormToInput', () => {
  test('trims the fields and reads the switch', () => {
    expect(flockFormToInput(form(BASE))).toMatchObject({ breed: 'ollama', name: 'n', baseUrl: 'http://o', tlsTrust: true })
  })

  test('a blank credential field is OMITTED — "leave it alone" — never null, which would clear it', () => {
    const input = flockFormToInput(form({ ...BASE, id: '00000000-0000-4000-8000-000000000000', upstreamAuth: '  ' }))
    expect(input).not.toHaveProperty('upstreamAuth')
    expect(flockFormToInput(form(BASE))).not.toHaveProperty('upstreamAuth')
  })

  test('a filled credential field is sent trimmed', () => {
    expect(flockFormToInput(form({ ...BASE, upstreamAuth: ' tok ' })).upstreamAuth).toBe('tok')
  })

  test('no id means create', () => {
    expect(flockFormToInput(form(BASE)).id).toBeUndefined()
  })
})

describe('saveFlockErrorMessage', () => {
  test('passes through the errors the service raises on purpose', () => {
    const forbidden = new ForbiddenError('resource.write')
    expect(saveFlockErrorMessage(forbidden)).toBe(forbidden.message)
    expect(saveFlockErrorMessage(new NotFoundError('flock x'))).toBe('not found: flock x')
    expect(saveFlockErrorMessage(new CredentialRebindError())).toMatch(/upstreamAuth/)
    expect(saveFlockErrorMessage(new ZodError([]))).toBe('Invalid flock details')
    const invalid = saveFlockInput.safeParse({ breed: 'ollama', name: '', baseUrl: 'http://o', tlsTrust: false, upstreamAuth: '  ' })
    expect(invalid.success).toBe(false)
    expect(saveFlockErrorMessage(invalid.error)).toMatch(/^name: .*; upstreamAuth: /)
  })

  test('never echoes anything else — a driver error can carry the query and its sealed parameters', () => {
    const dbError = new Error('Failed query: update "flock" set "upstream_auth_enc" = $1\nparams: sealed:v1:abc')
    expect(saveFlockErrorMessage(dbError)).toBe('Failed to save flock')
    expect(saveFlockErrorMessage('nope')).toBe('Failed to save flock')
  })
})
