import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { NextRequest } from 'next/server'

const CONSOLE_URL = 'https://console.example.test'
// Behind a proxy, req.url is the container's own address — never where a browser should go.
const INTERNAL = 'http://0.0.0.0:3000'

const state = vi.hoisted(() => ({
  getOidcClient: (): unknown => { throw new Error('unset') },
  sessionSecret: (): string => 'x'.repeat(32),
  setTransactionCookie: async (): Promise<void> => {},
}))
vi.mock('../../server/oidc-session', () => ({
  getOidcClient: () => state.getOidcClient(),
  setTransactionCookie: () => state.setTransactionCookie(),
}))
vi.mock('../../server/current-user', () => ({ sessionSecret: () => state.sessionSecret() }))

const { GET } = await import('./route')

let log: ReturnType<typeof vi.spyOn>
beforeEach(() => { log = vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { log.mockRestore(); state.sessionSecret = () => 'x'.repeat(32) })

function client(authorizationUrl: () => Promise<string>) {
  return { cfg: { consoleUrl: CONSOLE_URL }, authorizationUrl: vi.fn(authorizationUrl) }
}
const req = () => new NextRequest(`${INTERNAL}/login?login_hint=a%40x.io`)

describe('GET /login', () => {
  test('redirects to the OP with the hint forwarded', async () => {
    const c = client(async () => 'https://auth.example.test/auth?x=1')
    state.getOidcClient = () => c
    const res = await GET(req())
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('https://auth.example.test/auth?x=1')
    expect(c.authorizationUrl).toHaveBeenCalledWith(expect.any(Object), 'a@x.io')
    expect(log).not.toHaveBeenCalled()
  })

  test('a console config that cannot load is reported as misconfigured, on req.url, and logged', async () => {
    state.getOidcClient = () => { throw new Error('CONSOLE_CLIENT_SECRET must be set (>=16 chars)') }
    const res = await GET(req())
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe(`${INTERNAL}/auth/error?reason=misconfigured`)
    expect(log).toHaveBeenCalledWith('[console] sign-in failed:', 'misconfigured', 'CONSOLE_CLIENT_SECRET must be set (>=16 chars)')
  })

  test('a missing SESSION_SECRET is misconfiguration too, not an unreachable OP', async () => {
    state.getOidcClient = () => client(async () => 'https://auth.example.test/auth')
    state.sessionSecret = () => { throw new Error('SESSION_SECRET must be set (>=16 chars)') }
    const res = await GET(req())
    expect(res.headers.get('location')).toBe(`${INTERNAL}/auth/error?reason=misconfigured`)
  })

  test('an unreachable OP is reported as unavailable, on CONSOLE_URL, and logged without leaking detail', async () => {
    state.getOidcClient = () => client(async () => { throw new Error('discovery failed: HTTP 502 internal-detail') })
    const res = await GET(req())
    expect(res.status).toBe(303)
    const location = res.headers.get('location')!
    expect(location).toBe(`${CONSOLE_URL}/auth/error?reason=unavailable`)
    expect(location).not.toContain('internal-detail')
    expect(log).toHaveBeenCalledWith('[console] sign-in failed:', 'unavailable', 'discovery failed: HTTP 502 internal-detail')
  })
})
