import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { adminApiResource, CAPABILITIES, type Capability } from '@metamodels/schema'
import { loadOidcClientConfig, onOrigin } from '../auth/oidc-client'
import type { Actor, Credential } from '../auth/authorize'
import { loadActiveActor } from './actor'
import type { Db } from './db'

/** Rotation window as OUR number, not jose's default — see spec §4.3. */
const JWKS_CACHE_MAX_AGE_MS = 10 * 60 * 1000
const JWKS_COOLDOWN_MS = 30 * 1000

/**
 * The presented token was judged and refused. The caller answers 401.
 *
 * `reason` and `cause` are for server-side logging ONLY and must never reach the client. `reason`
 * is NOT safe to echo: `'subject is not an active user'` separates a valid, correctly-signed token
 * for a deactivated account from a bad token, which is an account-enumeration oracle. `problem.ts`
 * answers every `TokenError` with one fixed 401 detail for exactly this reason.
 */
export class TokenError extends Error {
  readonly reason: string
  constructor(reason: string, options?: { cause?: unknown }) {
    super(`invalid token: ${reason}`, options)
    this.name = 'TokenError'
    this.reason = reason
  }
}

/**
 * The OP's key set could not be obtained, so the token was never judged at all.
 *
 * Distinct from `TokenError` on purpose: the token may be perfectly valid and the fault is ours.
 * The caller must answer 503, not 401 — a client that "fixes" a 401 by refreshing would only hit
 * the same unreachable OP, and an operator watching a wave of 401s would never learn the OP was
 * down. As with `TokenError`, `reason` and `cause` are for server-side logging only.
 */
export class KeySetUnavailableError extends Error {
  readonly reason: string
  constructor(reason: string, options?: { cause?: unknown }) {
    super(`admin token key set unavailable: ${reason}`, options)
    this.name = 'KeySetUnavailableError'
    this.reason = reason
  }
}

export interface AdminClaims {
  sub: string
  scope?: string
  client_id?: string
  jti?: string
}

const CAPABILITY_SET: ReadonlySet<string> = new Set(CAPABILITIES)

/**
 * Granted scopes as capabilities. ALWAYS a concrete set — an unscoped token must intersect to
 * nothing and be denied, not fall through C3's `?? true` into full role power (spec §2.3).
 */
export function grantsFromScope(scope: string | undefined): ReadonlySet<Capability> {
  const out = new Set<Capability>()
  for (const s of (scope ?? '').split(/\s+/)) {
    if (CAPABILITY_SET.has(s)) out.add(s as Capability)
  }
  return out
}

/** `audit_log.changed_by` for a bearer. Never returns `session`, which is the cookie path's value. */
export function credentialOf(claims: { client_id?: string; jti?: string }): Credential {
  return `token:${claims.client_id ?? 'unknown'}:${claims.jti ?? 'unknown'}`
}

let jwks: JWTVerifyGetKey | undefined

/**
 * One process-wide remote key set, mirroring how oidc-client.ts serves the console: the published
 * `${issuer}/jwks` re-homed onto the internal hop with `onOrigin`, exactly as the console re-homes
 * `jwks_uri`. `kid` is resolved from the published JWKS and never pinned, so an
 * OIDC_PREVIOUS_SIGNING_KEYS overlap works here without a redeploy.
 */
export function adminJwks(): JWTVerifyGetKey {
  if (jwks) return jwks
  const cfg = loadOidcClientConfig()
  jwks = createRemoteJWKSet(new URL(onOrigin(`${cfg.issuer}/jwks`, cfg.internalUrl)), {
    cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
    cooldownDuration: JWKS_COOLDOWN_MS,
  })
  return jwks
}

/** Drops the cached key set. For tests, which point the internal hop at a throwaway JWKS server. */
export function resetAdminJwks(): void {
  jwks = undefined
}

/**
 * Why the *key set* — rather than the token — is at fault, or `undefined` when this is a token
 * defect. Deliberately an allowlist: anything unrecognised stays a token rejection, which is the
 * conservative answer, so a jose release that adds an error class cannot turn a bad token into a 503.
 */
function keySetFailure(e: unknown): string | undefined {
  if (e instanceof joseErrors.JWKSTimeout) return 'timed out fetching the key set'
  if (e instanceof joseErrors.JWKSNoMatchingKey) return 'no published key matches the token `kid`'
  if (e instanceof joseErrors.JWKSInvalid) return 'the published key set is malformed'
  if (e instanceof joseErrors.JOSEError) {
    // The base class itself is what jose throws for a non-200 or unparseable JWKS response; every
    // complaint about the token is one of its subclasses, and each carries its own code.
    return e.code === 'ERR_JOSE_GENERIC' ? 'the key set endpoint did not return a usable JWKS' : undefined
  }
  // Not a jose error at all — a fetch `TypeError`, a DNS failure, an unusable internal URL. Never
  // something the presented token could have caused.
  return 'the key set endpoint could not be reached'
}

export async function verifyAdminToken(jwt: string): Promise<AdminClaims> {
  const cfg = loadOidcClientConfig()
  let payload: Record<string, unknown>
  let header: Record<string, unknown>
  try {
    const res = await jwtVerify(jwt, adminJwks(), {
      issuer: cfg.issuer,
      algorithms: ['RS256'],
      typ: 'at+jwt',
      // RFC 9068 §2.2 makes `exp` REQUIRED, and jose only checks the claim when it is present. Without
      // this, a token minted without `exp` would verify forever: this path is offline, with no
      // introspection and no revocation, so nothing short of a key rotation could take it back.
      requiredClaims: ['exp'],
    })
    payload = res.payload as Record<string, unknown>
    header = res.protectedHeader as unknown as Record<string, unknown>
  } catch (e) {
    const unavailable = keySetFailure(e)
    if (unavailable) throw new KeySetUnavailableError(unavailable, { cause: e })
    throw new TokenError('signature, issuer, typ or expiry rejected', { cause: e })
  }
  if (header.alg !== 'RS256') throw new TokenError('alg must be RS256')

  // RFC 9068 allows `aud` to be a string or an array; M1 mints a bare string. Accept both.
  const want = adminApiResource(cfg.consoleUrl)
  const aud = payload.aud
  const ok = typeof aud === 'string' ? aud === want : Array.isArray(aud) && aud.includes(want)
  if (!ok) throw new TokenError('audience is not the admin API resource')

  const sub = payload.sub
  if (typeof sub !== 'string' || !sub) throw new TokenError('missing sub')
  return {
    sub,
    scope: typeof payload.scope === 'string' ? payload.scope : undefined,
    client_id: typeof payload.client_id === 'string' ? payload.client_id : undefined,
    jti: typeof payload.jti === 'string' ? payload.jti : undefined,
  }
}

/** Token → Actor. The user row is re-read, so deactivation takes effect immediately, as on the cookie path. */
export async function actorFromToken(db: Db, jwt: string): Promise<Actor> {
  const claims = await verifyAdminToken(jwt)
  const actor = await loadActiveActor(db, claims.sub, credentialOf(claims))
  if (!actor) throw new TokenError('subject is not an active user')
  return { ...actor, grants: grantsFromScope(claims.scope) }
}
