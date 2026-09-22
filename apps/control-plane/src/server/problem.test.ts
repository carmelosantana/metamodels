import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { ForbiddenError } from '../auth/authorize'
import { KeySetUnavailableError, TokenError } from './admin-token'
import { NotFoundError } from './flocks-service'
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

  test('an unknown error becomes 500 and leaks no message', async () => {
    const res = problemForError(new Error('connection string postgres://u:p@h/db'))
    expect(res.status).toBe(500)
    const body = await res.json() as { detail?: string }
    expect(JSON.stringify(body)).not.toContain('postgres://')
  })
})
