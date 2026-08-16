import { describe, it, expect } from 'vitest'
import { buildCsp, HSTS_VALUE } from './csp.js'

/** Parse a CSP header string into { directive: [values] } for order-independent assertions. */
function parse(csp: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const part of csp.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue
    out[tokens[0]] = tokens.slice(1)
  }
  return out
}

describe('buildCsp', () => {
  it('locks down the dangerous sinks in production', () => {
    const d = parse(buildCsp('abc123', { dev: false }))
    // The three directives that actually stop injected markup from doing damage.
    expect(d['object-src']).toEqual(["'none'"])
    expect(d['base-uri']).toEqual(["'self'"])
    expect(d['frame-ancestors']).toEqual(["'none'"])
    // Forms must not be able to POST credentials off-origin.
    expect(d['form-action']).toEqual(["'self'"])
    expect(d['default-src']).toEqual(["'self'"])
  })

  it('binds scripts to the per-request nonce and never allows unsafe-inline', () => {
    const csp = buildCsp('abc123', { dev: false })
    const d = parse(csp)
    expect(d['script-src']).toContain("'nonce-abc123'")
    // 'strict-dynamic' is what lets the nonce'd Next bootstrap pull in its own chunks.
    expect(d['script-src']).toContain("'strict-dynamic'")
    expect(d['script-src']).not.toContain("'unsafe-inline'")
    expect(d['script-src']).not.toContain("'unsafe-eval'")
  })

  it('threads a different nonce through on every call', () => {
    expect(buildCsp('nonce-one', { dev: false })).not.toEqual(buildCsp('nonce-two', { dev: false }))
    expect(buildCsp('nonce-one', { dev: false })).toContain("'nonce-nonce-one'")
  })

  it('keeps every network egress on-origin', () => {
    const d = parse(buildCsp('abc123', { dev: false }))
    // next/font/google self-hosts its downloads at build time, so no external font origin.
    expect(d['font-src']).toEqual(["'self'"])
    expect(d['connect-src']).toEqual(["'self'"])
    // Data/blob images are needed for inline previews; remote image origins are not.
    expect(d['img-src']).toEqual(["'self'", 'data:', 'blob:'])
    expect(d['frame-src']).toEqual(["'none'"])
    expect(d['worker-src']).toEqual(["'self'", 'blob:'])
  })

  it('does not upgrade-insecure-requests (self-hosters run plain HTTP on a LAN)', () => {
    expect(buildCsp('abc123', { dev: false })).not.toContain('upgrade-insecure-requests')
  })

  it('relaxes only what the dev server structurally requires', () => {
    const d = parse(buildCsp('abc123', { dev: true }))
    // webpack HMR evaluates module code and opens a websocket back to the dev server.
    expect(d['script-src']).toContain("'unsafe-eval'")
    expect(d['connect-src']).toContain('ws:')
    // The dangerous sinks stay shut even in dev.
    expect(d['object-src']).toEqual(["'none'"])
    expect(d['frame-ancestors']).toEqual(["'none'"])
  })

  it('emits a single-line header with no trailing separator', () => {
    const csp = buildCsp('abc123', { dev: false })
    expect(csp).not.toMatch(/[\r\n]/)
    expect(csp.endsWith(';')).toBe(false)
  })
})

describe('HSTS_VALUE', () => {
  it('is a two-year max-age scoped to this exact host', () => {
    expect(HSTS_VALUE).toBe('max-age=63072000')
    // No includeSubDomains/preload by default: a self-hosted console must not silently
    // impose HTTPS on sibling subdomains its operator also runs. Documented in DEPLOY.md.
    expect(HSTS_VALUE).not.toContain('includeSubDomains')
    expect(HSTS_VALUE).not.toContain('preload')
  })
})
