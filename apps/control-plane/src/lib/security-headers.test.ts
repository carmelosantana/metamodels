import { describe, it, expect } from 'vitest'
import nextConfig from '../../next.config.js'
import { HSTS_VALUE } from './csp.js'

/** The static header set Next applies to every response, as a lookup. */
async function staticHeaders(): Promise<Record<string, string>> {
  const rules = await nextConfig.headers!()
  const catchAll = rules.find((r) => r.source === '/:path*')
  expect(catchAll, 'next.config must keep a catch-all header rule').toBeDefined()
  return Object.fromEntries(catchAll!.headers.map((h) => [h.key, h.value]))
}

describe('static security headers', () => {
  it('applies HSTS with exactly the value csp.ts documents', async () => {
    // next.config.ts is compiled in isolation and cannot import from src/, so the value is
    // duplicated there. This assertion is what stops the copies from drifting apart.
    expect((await staticHeaders())['Strict-Transport-Security']).toBe(HSTS_VALUE)
  })

  it('keeps the anti-framing and anti-sniffing headers', async () => {
    const h = await staticHeaders()
    expect(h['X-Frame-Options']).toBe('DENY')
    expect(h['X-Content-Type-Options']).toBe('nosniff')
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin')
    expect(h['Permissions-Policy']).toBe('camera=(), microphone=(), geolocation=()')
  })

  it('does not set a static CSP that would shadow the per-request nonce policy', async () => {
    // Two CSP headers on one response are intersected by the browser, so a static one here
    // would silently override the nonce policy from middleware.
    expect(await staticHeaders()).not.toHaveProperty('Content-Security-Policy')
  })

  it('does not advertise the framework', () => {
    expect(nextConfig.poweredByHeader).toBe(false)
  })
})
