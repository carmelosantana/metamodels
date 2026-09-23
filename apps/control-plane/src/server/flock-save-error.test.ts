import { describe, expect, test } from 'vitest'
import { ZodError } from 'zod'
import { ForbiddenError } from '../auth/authorize'
import { saveFlockInput } from '../lib/flock-schema'
import { CredentialRebindError, NotFoundError } from './flocks-service'
import { saveFlockErrorMessage } from './flock-save-error'

describe('saveFlockErrorMessage', () => {
  test('passes through the errors the service raises on purpose', () => {
    const forbidden = new ForbiddenError('resource.write')
    expect(saveFlockErrorMessage(forbidden)).toBe(forbidden.message)
    expect(saveFlockErrorMessage(new NotFoundError('flock x'))).toBe('not found: flock x')
    expect(saveFlockErrorMessage(new CredentialRebindError())).toMatch(/credential/i)
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

describe('saveFlockErrorMessage — the rebind refusal in console words', () => {
  // The API's 409 tells a client to re-send `upstreamAuth` "or null"; a console user can do neither
  // by those names, so the console gets its own sentence for the same refusal.
  test('names what to do in the form, not the API field or null', () => {
    const msg = saveFlockErrorMessage(new CredentialRebindError())
    expect(msg).not.toMatch(/\bnull\b|upstreamAuth/)
    expect(msg).toMatch(/re-enter/i)
  })

  test('the API keeps its own wording', () => {
    expect(new CredentialRebindError().message).toMatch(/upstreamAuth.*null/)
  })
})
