import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { adminApiResource, CAPABILITIES, type Capability } from '@metamodels/schema'
import { loadOidcClientConfig, onOrigin } from '../auth/oidc-client'
import type { Actor, Credential } from '../auth/authorize'
import { loadActiveActor } from './actor'
import type { Db } from './db'

/** Rotation window as OUR number, not jose's default — see spec §4.3. */
const JWKS_CACHE_MAX_AGE_MS = 10 * 60 * 1000
const JWKS_COOLDOWN_MS = 30 * 1000

export class TokenError extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(`invalid token: ${reason}`)
    this.name = 'TokenError'
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

export async function verifyAdminToken(jwt: string): Promise<AdminClaims> {
  const cfg = loadOidcClientConfig()
  let payload: Record<string, unknown>
  let header: Record<string, unknown>
  try {
    const res = await jwtVerify(jwt, adminJwks(), {
      issuer: cfg.issuer,
      algorithms: ['RS256'],
      typ: 'at+jwt',
    })
    payload = res.payload as Record<string, unknown>
    header = res.protectedHeader as unknown as Record<string, unknown>
  } catch {
    throw new TokenError('signature, issuer, typ or expiry rejected')
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
