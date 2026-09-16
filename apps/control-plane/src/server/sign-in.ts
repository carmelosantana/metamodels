import type { Actor } from '../auth/authorize'
import type { AuthTransaction } from '../auth/oidc-client'

export type SignInFailure =
  | 'access_denied'
  | 'provider_error'
  | 'state_mismatch'
  | 'issuer_mismatch'
  | 'missing_code'
  | 'token_exchange_failed'
  | 'account_unavailable'

export type SignInResult = { ok: true; actor: Actor } | { ok: false; reason: SignInFailure }

export interface SignInDeps {
  issuer: string
  exchangeCode(code: string, tx: AuthTransaction): Promise<{ sub: string }>
  loadActor(sub: string): Promise<Actor | null>
}

/**
 * Validate the OP's redirect to /auth/callback and resolve it to an Actor. Pure — no cookies, no
 * Next — so every rejection path is unit-tested. Order matters: nothing reaches the token endpoint
 * until state and issuer have both checked out.
 */
export async function completeSignIn(
  params: URLSearchParams, tx: AuthTransaction | null, deps: SignInDeps,
): Promise<SignInResult> {
  const error = params.get('error')
  if (error) return { ok: false, reason: error === 'access_denied' ? 'access_denied' : 'provider_error' }
  if (!tx || params.get('state') !== tx.state) return { ok: false, reason: 'state_mismatch' }
  // RFC 9207: our OP advertises authorization_response_iss_parameter_supported, so iss is mandatory.
  if (params.get('iss') !== deps.issuer) return { ok: false, reason: 'issuer_mismatch' }
  const code = params.get('code')
  if (!code) return { ok: false, reason: 'missing_code' }

  let sub: string
  try {
    ;({ sub } = await deps.exchangeCode(code, tx))
  } catch {
    return { ok: false, reason: 'token_exchange_failed' }
  }
  const actor = await deps.loadActor(sub)
  if (!actor) return { ok: false, reason: 'account_unavailable' }
  return { ok: true, actor }
}
