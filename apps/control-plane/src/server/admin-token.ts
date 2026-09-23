import { createRemoteJWKSet, decodeJwt, errors as joseErrors, jwtVerify, type RemoteJWKSet } from 'jose'
import { adminApiResource, CAPABILITIES, CLI_CLIENT_ID, type Capability } from '@metamodels/schema'
import { loadOidcClientConfig, onOrigin } from '../auth/oidc-client'
import type { Actor, Credential } from '../auth/authorize'
import { loadActiveActor } from './actor'
import type { Db } from './db'

/** Rotation window as OUR number, not jose's default — see spec §4.3. */
const JWKS_CACHE_MAX_AGE_MS = 10 * 60 * 1000
/** Exported for `problem.ts`, which logs the cooldown-miss 503 at most once per this window. */
export const JWKS_COOLDOWN_MS = 30 * 1000

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
 * The token could not be judged against a current key set: the OP's key set could not be obtained,
 * or the token names a `kid` missing from a set fetched too recently for jose to refetch it (see
 * `verifyAdminToken`).
 *
 * Distinct from `TokenError` on purpose: the token may be perfectly valid. The caller must answer
 * 503, not 401 — a client that "fixes" a 401 by refreshing would spend a refresh on a token that
 * may be fine (and, when the OP is down, hit the same unreachable OP), and an operator watching a
 * wave of 401s would never learn the OP was down. As with `TokenError`,
 * `reason` and `cause` are for server-side logging only.
 *
 * `cooldownMiss` is true for the second case. Anyone can cause it by sending a token with an unknown
 * `kid` while the set is cooling down, so `problem.ts` rate-limits its log line; a fetch failure is
 * logged every time.
 */
export class KeySetUnavailableError extends Error {
  readonly reason: string
  readonly cooldownMiss: boolean
  constructor(reason: string, options?: { cause?: unknown; cooldownMiss?: boolean }) {
    super(`admin token key set unavailable: ${reason}`, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'KeySetUnavailableError'
    this.reason = reason
    this.cooldownMiss = options?.cooldownMiss ?? false
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

let jwks: RemoteJWKSet | undefined

/**
 * One process-wide remote key set, mirroring how oidc-client.ts serves the console: the published
 * `${issuer}/jwks` re-homed onto the internal hop with `onOrigin`, exactly as the console re-homes
 * `jwks_uri`. `kid` is resolved from the published JWKS and never pinned, so an
 * OIDC_PREVIOUS_SIGNING_KEYS overlap works here without a redeploy.
 */
export function adminJwks(): RemoteJWKSet {
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
 * Why the *key set* could not be obtained, or `undefined` when this is a token defect. Deliberately
 * an allowlist: anything unrecognised stays a token rejection, which is the conservative answer, so
 * a jose release that adds an error class cannot turn a bad token into a 503. An unmatched `kid`
 * (`JWKSNoMatchingKey`) is not decided here: `verifyAdminToken` decides it before calling this.
 */
function keySetFailure(e: unknown): string | undefined {
  if (e instanceof joseErrors.JWKSTimeout) return 'timed out fetching the key set'
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

/**
 * True when the token's `exp`, read WITHOUT verifying the token, is already past. jose resolves the
 * signing key before it checks `exp`, so without this an expired token whose key has since been
 * dropped from the key set is a `kid` miss, and inside the cooldown a miss is a 503. The rotation
 * procedure drops a key only after every token it signed has expired, so every such token takes
 * this path and gets the same 401 as an expired token with a known key.
 *
 * Rejection-only: an unverified claim can make this return true and the token be refused, never
 * make a token be accepted. Anything that is not a numeric `exp` in the past (no `exp`, a string
 * `exp`, a token that does not decode) returns false and is left to `jwtVerify`, which rejects it as
 * before. The comparison is jose's own (`lib/jwt_claims_set.js`): `now` in whole seconds, expired
 * when `exp <= now`. jose subtracts `clockTolerance` from `now`, and `verifyAdminToken` sets none.
 */
function expiredBeforeVerifying(jwt: string): boolean {
  let exp: unknown
  try {
    exp = decodeJwt(jwt).exp
  } catch {
    return false
  }
  return typeof exp === 'number' && exp <= Math.floor(Date.now() / 1000)
}

export async function verifyAdminToken(jwt: string): Promise<AdminClaims> {
  // Before the key set is touched: no fetch, and no cooldown to turn this into a 503. The client
  // sees the one fixed 401 every `TokenError` gets (`problem.ts`); the reason is server-side only.
  if (expiredBeforeVerifying(jwt)) throw new TokenError('expired, judged before resolving the signing key')
  const cfg = loadOidcClientConfig()
  const keySet = adminJwks()
  // Read BEFORE verifying: a fetch during the call restarts the cooldown. See the catch below.
  const wasCoolingDown = keySet.coolingDown
  let payload: Record<string, unknown>
  let header: Record<string, unknown>
  try {
    const res = await jwtVerify(jwt, keySet, {
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
    /**
     * No key in the set matches the token's `kid`. jose (`jwks/remote.js`) reloads the set at the
     * start of a call when it has none or it is older than `cacheMaxAge`, and on a miss reloads once
     * more only when the set is past `cooldownDuration`. A reload already in flight from a
     * concurrent verification is awaited, not repeated. So:
     *
     * - Not cooling down at the start → 401. Whichever reload ran, the set was loaded during this
     *   call (or by a concurrent verification's load, requested moments before it) and the `kid` was
     *   looked up in it: the key is retired or forged, and the client should refresh.
     * - Cooling down → 503. The set was fetched under `JWKS_COOLDOWN_MS` ago and jose refetched
     *   nothing, so the `kid` may belong to a signer the OP began publishing since. A token whose
     *   numeric `exp` had passed never gets here: it was refused before the key set was consulted
     *   (`expiredBeforeVerifying`). The cooldown ends within the 30 s `Retry-After`. A retry after
     *   that may refetch, but another request may start a new cooldown first: any successful fetch
     *   starts one, including an ordinary request's `cacheMaxAge` reload.
     *
     * Two races. `jwtVerify` awaits between the read above and jose's cooldown check, so other
     * requests run in between. If the cooldown ends in that gap, jose runs `reload()` and looks the
     * `kid` up again: the token verifies if the OP now publishes that key, and the answer is 503 if
     * the `kid` is still missing. It is 503 too if that reload fails: jose then throws the fetch's
     * error, not a `kid` miss, and `keySetFailure` below turns it into a 503. If a concurrent
     * verification's load lands between jose's miss and its check, jose skips its own reload without
     * consulting the new set, and the answer is 401.
     */
    if (e instanceof joseErrors.JWKSNoMatchingKey) {
      if (wasCoolingDown) {
        throw new KeySetUnavailableError(
          'the token `kid` is not in a key set fetched too recently to refetch', { cause: e, cooldownMiss: true })
      }
      throw new TokenError('the token `kid` is not in a key set fetched during this verification', { cause: e })
    }
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

  // Spec A15: only the CLI, whose device flow asks for the password every time (A4), may hold an
  // admin-API token. The OP issues it to no other client (`resourcesByClient`); this is the second
  // lock, so a client M4 admits and lists there by mistake still gets nothing here.
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
