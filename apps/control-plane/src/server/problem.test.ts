import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { ForbiddenError } from '../auth/authorize'
import { KeySetUnavailableError, TokenError } from './admin-token'
import { NotFoundError } from './flocks-service'
import { SlugTakenError } from './paddocks-service'
import { problem, problemForError } from './problem'

describe('problem', () => {
  test('is application/problem+json with the RFC 9457 members', async () => {
    const res = problem(403, 'Forbidden', 'nope')
    expect(res.status).toBe(403)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
    await expect(res.json()).resolves.toEqual({
      type: 'about:blank', title: 'Forbidden', status: 403, detail: 'nope',
    })
  })
})

describe('problemForError', () => {
  test('ForbiddenError becomes 403 naming the missing capability', async () => {
    const res = problemForError(new ForbiddenError('user.manage'))
    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({ status: 403, capability: 'user.manage' })
  })

  test('NotFoundError becomes 404', () => {
    expect(problemForError(new NotFoundError('flock x')).status).toBe(404)
  })

  test('a ZodError becomes 422 and carries the issues', async () => {
    const parsed = z.object({ a: z.string() }).safeParse({})
    const res = problemForError(parsed.success ? new Error('unreachable') : parsed.error)
    expect(res.status).toBe(422)
    await expect(res.json()).resolves.toHaveProperty('errors')
  })

  /**
   * `ZodError` is no longer the body parser's private error. Three sources reach this arm now —
   * `readJsonObject` (a body), `parsePathId` (a path segment) and the usage reports' query schemas
   * (a query string) — and `GET /flocks/my-flock` carries no body at all. A `detail` naming the
   * body contradicts the `errors[]` beside it, on a response Task 10 is about to document.
   *
   * The issues themselves are the precise half; `detail` is the half that must not lie. Nothing in
   * a `ZodError` records which of the three threw it, so the fix is for `detail` to stop naming a
   * source rather than to guess one.
   */
  test.each([
    ['a body', ['name'] as const],
    ['a path segment', ['id'] as const],
    ['a query parameter', ['startBucket'] as const],
  ])('the 422 detail does not claim a body when the fault was %s', async (_src, path) => {
    const res = problemForError(new z.ZodError([{ code: 'custom', path: [...path], message: 'bad' }]))
    const body = await res.json() as { detail: string; errors: { path: string }[] }
    // The positive anchor: this really is the issue under test, not some other 422.
    expect(body.errors).toEqual([{ path: path[0], message: 'bad' }])
    expect(body.detail).toBe('request failed validation')
    expect(body.detail).not.toContain('body')
  })

  test('TokenError becomes 401', () => {
    expect(problemForError(new TokenError('expired')).status).toBe(401)
  })

  // The defect this test exists for: `TokenError.message` embeds `reason`, and one shipped reason
  // is 'subject is not an active user' — a valid, correctly-signed token for a deactivated account.
  // Echoing it would tell an attacker holding a token whether the account still exists.
  test('the 401 body is byte-identical whatever the TokenError reason was', async () => {
    const bodies = await Promise.all(
      ['subject is not an active user', 'alg must be RS256', 'audience is not the admin API resource']
        .map(async (reason) => await problemForError(new TokenError(reason)).text()),
    )
    expect(new Set(bodies).size).toBe(1)
    for (const body of bodies) {
      expect(body).not.toContain('active user')
      expect(body).not.toContain('RS256')
      expect(body).not.toContain('audience')
    }
  })

  test('a KeySetUnavailableError becomes 503 with Retry-After, never 401', async () => {
    const e = new KeySetUnavailableError('the key set endpoint could not be reached', {
      cause: new Error('connect ECONNREFUSED 10.0.0.7:8443'),
    })
    const res = problemForError(e)
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('30')
    const body = await res.text()
    expect(body).toContain('"title":"Service Unavailable"')
    expect(body).not.toContain('key set')
    expect(body).not.toContain('ECONNREFUSED')
  })

  test('a SlugTakenError becomes 409 and names the clashing slug', async () => {
    const res = problemForError(new SlugTakenError('north-field'))
    expect(res.status).toBe(409)
    await expect(res.json()).resolves.toMatchObject({
      status: 409, title: 'Conflict', detail: expect.stringContaining('north-field'),
    })
  })

  // RFC 9110 §15.5.2 makes WWW-Authenticate a MUST on a 401 — an HTTP conformance rule, not an
  // OAuth nicety. The bare scheme and nothing else: an `error="invalid_token"` parameter would
  // reopen the very enumeration oracle the fixed 401 detail closes.
  test('the 401 carries a bare Bearer challenge with no error parameter', async () => {
    const res = problemForError(new TokenError('subject is not an active user'))
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Bearer')
    expect(res.headers.get('www-authenticate')).not.toContain('error')
  })

  test('an unknown error becomes 500 and leaks no message', async () => {
    const res = problemForError(new Error('connection string postgres://u:p@h/db'))
    expect(res.status).toBe(500)
    const body = await res.json() as { detail?: string }
    expect(JSON.stringify(body)).not.toContain('postgres://')
  })
})
