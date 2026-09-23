import { afterEach, describe, expect, test, vi } from 'vitest'
import { z } from 'zod'
import { ForbiddenError } from '../auth/authorize'
import { KeySetUnavailableError, TokenError } from './admin-token'
import { NotFoundError } from './flocks-service'
import { SlugTakenError } from './paddocks-service'
import { problem, problemForError } from './problem'
// The three real producers whose `ZodError`s this module has to answer 422.
import { readJsonObject } from './json-body'
import { parsePathId } from './path-id'
import { dailyQuery } from './usage-query'

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
   * body contradicts the `errors[]` beside it, on a response the OpenAPI document publishes.
   *
   * The issues themselves are the precise half; `detail` is the half that must not lie. Nothing in
   * a `ZodError` records which of the three threw it, so the fix is for `detail` to stop naming a
   * source rather than to guess one.
   *
   * ⚠ Each row REALLY CALLS ITS SOURCE. An earlier version of this table handed three synthetic
   * `ZodError`s to the same arm with only `path` differing, which proved one thing three times and
   * would have kept passing if two of the three producers had stopped throwing `ZodError` at all —
   * the failure that would put a 500 in front of a caller. What is under test is that three
   * separate modules still converge on this arm, so the errors come from the modules.
   */
  const ZOD_ERROR_SOURCES: [string, () => Promise<unknown>, string][] = [
    [
      'a body',
      async () => {
        try {
          await readJsonObject(new Request('https://console.test/x', { method: 'POST', body: '{"name":' }))
        } catch (e) {
          return e
        }
        throw new Error('readJsonObject accepted a truncated body')
      },
      '',
    ],
    [
      'a path segment',
      async () => {
        try {
          parsePathId('my-flock')
        } catch (e) {
          return e
        }
        throw new Error('parsePathId accepted a non-uuid')
      },
      'id',
    ],
    [
      'a query parameter',
      // The bad bucket is the END one deliberately: digits sort before letters, so a malformed
      // START bucket also trips the runs-forwards refinement and the row would be asserting two
      // issues where it means to assert one.
      async () =>
        dailyQuery.safeParse({ dim: 'tokens_out', startBucket: '2026-01-01T00', endBucket: 'nope' }).error,
      'endBucket',
    ],
  ]

  test.each(ZOD_ERROR_SOURCES)(
    'the 422 detail does not claim a body when the fault was %s',
    async (_src, produce, expectedPath) => {
      const err = await produce()
      // The producer really threw the error this arm claims to handle — not a lookalike.
      expect(err).toBeInstanceOf(z.ZodError)
      const res = problemForError(err)
      expect(res.status).toBe(422)
      const body = await res.json() as { detail: string; errors: { path: string }[] }
      // The positive anchor: this really is the issue under test, not some other 422.
      expect(body.errors.map((e) => e.path)).toEqual([expectedPath])
      expect(body.detail).toBe('request failed validation')
      expect(body.detail).not.toContain('body')
    },
  )

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

  test('the 503 detail is one fixed string, true whether the key set could not be fetched or cannot be refetched yet', async () => {
    // In the cooldown case the sign-in service is fine; the console just may not fetch its keys
    // again yet. So the detail must not say the service is unreachable, and it must not say which
    // case this is.
    const causes = [
      new KeySetUnavailableError('the key set endpoint could not be reached'),
      new KeySetUnavailableError('the token `kid` is not in a key set fetched too recently to refetch'),
    ]
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const details = await Promise.all(
      causes.map(async (e) => ((await problemForError(e).json()) as { detail?: string }).detail),
    )
    vi.restoreAllMocks()
    expect(new Set(details).size).toBe(1)
    expect(details[0]).toBe('the access token cannot be verified right now; retry after the Retry-After interval')
    expect(details[0]).not.toMatch(/unreachable|authorization server/)
  })

  describe('the 503 log', () => {
    afterEach(() => vi.restoreAllMocks())

    test('each 503 is logged once, as strings: reason, then the cause\'s name and message on one line', () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      const cause = new TypeError('fetch failed\r\nforged: line')
      problemForError(new KeySetUnavailableError('the key set endpoint could not be reached', { cause }))
      expect(log).toHaveBeenCalledTimes(1)
      const args = log.mock.calls[0]!
      for (const a of args) expect(typeof a).toBe('string')
      expect(args).toEqual([
        '[admin-api] 503, key set unavailable:',
        'the key set endpoint could not be reached',
        'TypeError: fetch failed  forged: line',
      ])
    })

    test('a cause-less 503 says so, and a 401 is not logged at all', () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      problemForError(new KeySetUnavailableError('timed out fetching the key set'))
      expect(log.mock.calls[0]![2]).toBe('no cause')
      problemForError(new TokenError('expired'))
      expect(log).toHaveBeenCalledTimes(1)
    })

    test('every control character that could fake a line or drive a terminal is replaced, in the reason and the cause', () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      // U+2028 and U+2029 end a line in JavaScript and in some log viewers; ESC starts a terminal
      // escape sequence; the rest of C0 (NUL, BEL, TAB…), DEL and C1 (0x9B is a one-byte CSI) go too.
      const cause = new TypeError('a\u2028b\u2029c\x1b[2Jd\x00e\tf\x07g\x7fh\x9bi')
      problemForError(new KeySetUnavailableError('timed out\x1b[31m fetching', { cause }))
      const [, reason, logged] = log.mock.calls[0]!
      expect(reason).toBe('timed out [31m fetching')
      expect(logged).toBe('TypeError: a b c [2Jd e f g h i')
      for (const a of log.mock.calls[0]!) expect(a).not.toMatch(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/)
    })
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
