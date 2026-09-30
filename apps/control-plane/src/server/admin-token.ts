import { adminApiResource, CAPABILITIES, CLI_CLIENT_ID, type Capability } from '@metamodels/schema'
import {
  AUDIENCE_MISMATCH, createAccessTokenVerifier, JWKS_COOLDOWN_MS, KeySetUnavailableError, TokenError,
  type AccessTokenVerifier,
} from '@metamodels/schema/access-token'
import { loadOidcClientConfig, onOrigin } from '../auth/oidc-client'
import type { Actor, Credential } from '../auth/authorize'
import { loadActiveActor } from './actor'
import type { Db } from './db'

// Re-exported so `problem.ts`, `admin-route.ts` and their tests keep importing from here: the class
// identity is the shared package's, so `instanceof` agrees wherever an error is caught.
export { JWKS_COOLDOWN_MS, KeySetUnavailableError, TokenError }

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

let verifier: AccessTokenVerifier | undefined

/**
 * One process-wide verifier, and with it one remote key set: the published `${issuer}/jwks`
 * re-homed onto the internal hop with `onOrigin`, exactly as the console re-homes `jwks_uri`.
 */
function adminVerifier(cfg: { issuer: string; internalUrl: string }): AccessTokenVerifier {
  verifier ??= createAccessTokenVerifier({
    issuer: cfg.issuer,
    jwksUrl: onOrigin(`${cfg.issuer}/jwks`, cfg.internalUrl),
    typ: 'at+jwt',
  })
  return verifier
}

/** Drops the cached verifier and its key set. For tests, which point the internal hop at a throwaway JWKS. */
export function resetAdminJwks(): void {
  verifier = undefined
}

export async function verifyAdminToken(jwt: string): Promise<AdminClaims> {
  const cfg = loadOidcClientConfig()
  let payload: Record<string, unknown>
  try {
    payload = await adminVerifier(cfg)(jwt, adminApiResource(cfg.consoleUrl))
  } catch (e) {
    // The shared verifier names no resource in its reason; this API's logs always have.
    if (e instanceof TokenError && e.reason === AUDIENCE_MISMATCH) {
      throw new TokenError('audience is not the admin API resource', { cause: e })
    }
    throw e
  }

  // Spec A15: only the CLI, whose device flow asks for the password every time (A4), may hold an
  // admin-API token. The OP issues it to no other client (`resourcesByClient`); this is the second
  // lock, so a client M4 admits (a CIMD client) and lists there by mistake still gets nothing here.
  if (payload.client_id !== CLI_CLIENT_ID) throw new TokenError('client_id is not the admin CLI')

  const sub = payload.sub
  if (typeof sub !== 'string' || !sub) throw new TokenError('missing sub')
  return {
    sub,
    scope: typeof payload.scope === 'string' ? payload.scope : undefined,
    client_id: CLI_CLIENT_ID,
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
