import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { NextRequest } from 'next/server'

const INTERNAL = 'http://0.0.0.0:3000'

const state = vi.hoisted(() => ({
  getOidcClient: (): unknown => { throw new Error('unset') },
  takeTransactionCookie: vi.fn(async () => null),
}))
vi.mock('../../../server/oidc-session', () => ({
  getOidcClient: () => state.getOidcClient(),
  takeTransactionCookie: state.takeTransactionCookie,
}))
vi.mock('../../../server/current-user', () => ({
  sessionSecret: () => 'x'.repeat(32),
  setSessionCookie: vi.fn(),
}))
vi.mock('../../../server/actor', () => ({ loadActiveActor: vi.fn() }))
vi.mock('../../../server/db', () => ({ getDb: vi.fn() }))
vi.mock('../../../server/license-on-login', () => ({ revalidateLicenseOnLogin: vi.fn() }))

const { GET } = await import('./route')

let log: ReturnType<typeof vi.spyOn>
beforeEach(() => { log = vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { log.mockRestore() })

describe('GET /auth/callback', () => {
  test('a console config that cannot load is a misconfigured page, not a bare 500', async () => {
    state.getOidcClient = () => { throw new Error('OIDC_ISSUER is required') }
    const res = await GET(new NextRequest(`${INTERNAL}/auth/callback?code=secret-code&state=s`))
    expect(res.status).toBe(303)
    const location = res.headers.get('location')!
    expect(location).toBe(`${INTERNAL}/auth/error?reason=misconfigured`)
    expect(location).not.toContain('secret-code')
    expect(log).toHaveBeenCalledWith('[console] sign-in failed:', 'misconfigured', 'OIDC_ISSUER is required')
    for (const call of log.mock.calls) expect(call.join(' ')).not.toContain('secret-code')
  })

  test('an OP-side failure is logged and redirected on CONSOLE_URL', async () => {
    state.getOidcClient = () => ({
      cfg: { issuer: 'https://auth.example.test', consoleUrl: 'https://console.example.test' },
      exchangeCode: vi.fn(async () => { throw new Error('token exchange failed: invalid_client') }),
    })
    state.takeTransactionCookie.mockResolvedValueOnce({ state: 's', nonce: 'n', codeVerifier: 'v' } as never)
    const res = await GET(new NextRequest(`${INTERNAL}/auth/callback?code=secret-code&state=s&iss=https%3A%2F%2Fauth.example.test`))
    expect(res.headers.get('location')).toBe('https://console.example.test/auth/error?reason=token_exchange_failed')
    expect(log).toHaveBeenCalledWith('[console] sign-in failed:', 'token_exchange_failed', 'token exchange failed: invalid_client')
    for (const call of log.mock.calls) expect(call.join(' ')).not.toContain('secret-code')
  })
})
