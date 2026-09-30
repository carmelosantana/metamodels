import { CONSENT_ASSERTION_TYP, internalApiAudience } from '@metamodels/schema'
import { createAccessTokenVerifier, TokenError, type AccessTokenVerifier } from '@metamodels/schema/access-token'
import { loadOidcClientConfig, onOrigin } from '../auth/oidc-client'

/** Spec §3.5: an assertion lives at most 60 s. The OP mints them with 30. */
export const MAX_ASSERTION_LIFETIME_S = 60

export interface ConsentClaims {
  /** The approving user's id. */
  sub: string
  clientId: string
  clientName: string
  /** The MCP resource indicator approved; the route parses the paddock slug from it. */
  resource: string
  jti: string
  exp: number
  /** The OP grant. Required by the mint; absent on a preflight, when no grant exists yet. */
  grantId?: string
}

let verifier: AccessTokenVerifier | undefined

export function resetConsentVerifier(): void {
  verifier = undefined
}

/**
 * The OP's consent assertion, verified with the shared verifier against the JWKS this server already
 * trusts, with `typ` and `aud` fixed. Nothing in it is trusted beyond "the OP says this user approved
 * this client for this resource under this grant": the route re-derives the user, the org, the
 * capability and the paddock from the database.
 */
export async function verifyConsentAssertion(jwt: string, opts: { requireGrant: boolean }): Promise<ConsentClaims> {
  const cfg = loadOidcClientConfig()
  verifier ??= createAccessTokenVerifier({
    issuer: cfg.issuer,
    jwksUrl: onOrigin(`${cfg.issuer}/jwks`, cfg.internalUrl),
    typ: CONSENT_ASSERTION_TYP,
  })
  const p = await verifier(jwt, internalApiAudience(cfg.consoleUrl))

  // Both bounds: a declared life over 60 s, and an `exp` over 60 s from now. The second catches an
  // assertion whose `iat` is dated in the future, which the first alone would let live longer, and
  // keeps every verifiable `jti` inside the replay window.
  const { iat, exp } = p
  const now = Math.floor(Date.now() / 1000)
  if (
    typeof iat !== 'number' || typeof exp !== 'number'
    || exp - iat > MAX_ASSERTION_LIFETIME_S || exp - now > MAX_ASSERTION_LIFETIME_S
  ) {
    throw new TokenError(`assertion lifetime is not within ${MAX_ASSERTION_LIFETIME_S} s`)
  }
  const str = (k: string): string | undefined => (typeof p[k] === 'string' && p[k] !== '' ? p[k] as string : undefined)
  const sub = str('sub')
  const clientId = str('client_id')
  const clientName = str('client_name')
  const resource = str('resource')
  const jti = str('jti')
  const grantId = str('grant_id')
  if (!sub || !clientId || !clientName || !resource || !jti) throw new TokenError('assertion is missing a claim')
  if (opts.requireGrant && !grantId) throw new TokenError('assertion names no grant')
  return { sub, clientId, clientName, resource, jti, exp, ...(grantId ? { grantId } : {}) }
}
