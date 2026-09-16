import { describe, expect, test, vi } from 'vitest'
import type { Actor } from '../auth/authorize'
import { completeSignIn, type SignInDeps } from './sign-in'

const ISSUER = 'https://auth.example.test'
const TX = { state: 'st-1', nonce: 'n-1', codeVerifier: 'v'.repeat(43) }
const ACTOR: Actor = { id: 'u-1', orgId: 'o-1', email: 'op@x.io', role: 'admin' }

function deps(over: Partial<SignInDeps> = {}): SignInDeps {
  return {
    issuer: ISSUER,
    exchangeCode: vi.fn(async () => ({ sub: 'u-1' })),
    loadActor: vi.fn(async () => ACTOR),
    ...over,
  }
}

const ok = (extra: Record<string, string> = {}) =>
  new URLSearchParams({ code: 'c-1', state: 'st-1', iss: ISSUER, ...extra })

describe('completeSignIn', () => {
  test('a valid callback resolves to the Actor', async () => {
    const d = deps()
    expect(await completeSignIn(ok(), TX, d)).toEqual({ ok: true, actor: ACTOR })
    expect(d.exchangeCode).toHaveBeenCalledWith('c-1', TX)
    expect(d.loadActor).toHaveBeenCalledWith('u-1')
  })

  test('an OP error is reported, with only access_denied passed through by name', async () => {
    expect(await completeSignIn(new URLSearchParams({ error: 'access_denied', state: 'st-1' }), TX, deps()))
      .toEqual({ ok: false, reason: 'access_denied' })
    expect(await completeSignIn(new URLSearchParams({ error: 'server_error', state: 'st-1' }), TX, deps()))
      .toEqual({ ok: false, reason: 'provider_error' })
  })

  test('a missing transaction or a mismatched state stops before any token request', async () => {
    const d = deps()
    expect(await completeSignIn(ok(), null, d)).toEqual({ ok: false, reason: 'state_mismatch' })
    expect(await completeSignIn(ok({ state: 'forged' }), TX, d)).toEqual({ ok: false, reason: 'state_mismatch' })
    expect(d.exchangeCode).not.toHaveBeenCalled()
  })

  test('RFC 9207: a missing or foreign iss is rejected (the OP always sends it)', async () => {
    const missing = ok()
    missing.delete('iss')
    expect(await completeSignIn(missing, TX, deps())).toEqual({ ok: false, reason: 'issuer_mismatch' })
    expect(await completeSignIn(ok({ iss: 'https://impostor.test' }), TX, deps())).toEqual({ ok: false, reason: 'issuer_mismatch' })
  })

  test('a callback without a code is rejected', async () => {
    const p = ok()
    p.delete('code')
    expect(await completeSignIn(p, TX, deps())).toEqual({ ok: false, reason: 'missing_code' })
  })

  test('a failed token exchange is reported without leaking the error', async () => {
    const d = deps({ exchangeCode: vi.fn(async () => { throw new Error('secret detail') }) })
    expect(await completeSignIn(ok(), TX, d)).toEqual({ ok: false, reason: 'token_exchange_failed' })
  })

  test('a subject with no active account is refused', async () => {
    expect(await completeSignIn(ok(), TX, deps({ loadActor: vi.fn(async () => null) })))
      .toEqual({ ok: false, reason: 'account_unavailable' })
  })
})
