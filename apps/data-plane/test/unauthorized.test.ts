import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { API_KEY_CHALLENGE, unauthorizedKey, type KeyRejection } from '../src/unauthorized.js'

/** Every reason that describes a key the caller actually presented. */
const PRESENTED: KeyRejection[] = ['no key matches the presented hash', 'the presented key has expired']

describe('unauthorizedKey', () => {
  // Refusing a presented key logs its reason by design, so every case here would otherwise dirty
  // the run's stderr. Silenced centrally; the two tests that care read the spy.
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { warn.mockRestore() })
  test('is a 401 carrying the JSON error shape the proxy already emits', async () => {
    const res = unauthorizedKey('no key presented')
    expect(res.status).toBe(401)
    expect(res.headers.get('content-type')).toBe('application/json')
    await expect(res.json()).resolves.toEqual({ error: 'missing api key' })
  })

  // RFC 9110 §15.5.2 makes WWW-Authenticate a MUST on every 401 — an HTTP conformance rule,
  // independent of the auth scheme, and it was absent from all three of these responses.
  test('every 401 carries a challenge, whatever the reason', () => {
    for (const rejection of ['no key presented', ...PRESENTED] as KeyRejection[]) {
      expect(unauthorizedKey(rejection).headers.get('www-authenticate')).toBe('Bearer')
    }
  })

  // RFC 6750 §3 would permit error="invalid_token", but that would restate in a header exactly
  // the distinction the body below refuses to make, reopening the oracle.
  test('the challenge is the bare scheme with no error parameter', () => {
    expect(API_KEY_CHALLENGE).toBe('Bearer')
    const h = unauthorizedKey('the presented key has expired').headers.get('www-authenticate')!
    expect(h).not.toContain('error')
    expect(h).not.toContain('=')
  })

  // The defect this test exists for: 'invalid api key' vs 'expired api key' told a caller whether
  // the key it presented had ever existed and whether it had merely lapsed — an enumeration
  // oracle against consumer mm_live_ keys.
  test('the body is byte-identical for every reason describing a presented key', async () => {
    const bodies = await Promise.all(PRESENTED.map((r) => unauthorizedKey(r).text()))
    expect(new Set(bodies).size).toBe(1)
    for (const body of bodies) {
      expect(body).not.toContain('expired')
      expect(body).not.toContain('hash')
    }
  })

  // Kept distinct on purpose: it describes the caller's own request shape, not server-side state
  // about any key, so it is not an oracle — and RFC 6750 §3.1 says a request carrying no
  // credentials SHOULD NOT get an error code back.
  test('a request with no key at all stays distinguishable from a refused key', async () => {
    const missing = await unauthorizedKey('no key presented').text()
    const refused = await unauthorizedKey('no key matches the presented hash').text()
    expect(missing).not.toBe(refused)
  })

  test('the precise reason reaches the operator log, never the body', async () => {
    const body = await unauthorizedKey('the presented key has expired').text()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]!.join(' ')).toContain('the presented key has expired')
    expect(body).not.toContain('expired')
  })

  test('a request with no key is not logged — it is the caller, not a rejected credential', () => {
    unauthorizedKey('no key presented')
    expect(warn).not.toHaveBeenCalled()
  })
})
