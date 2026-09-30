import { KeySetUnavailableError, TokenError } from '@metamodels/schema/access-token'
import type { Actor } from '../auth/authorize'
import { loadActiveActor } from './actor'
import { bearerOf, hasSessionCookie } from './admin-route'
import { verifyConsentAssertion, type ConsentClaims } from './consent-assertion'
import { getDb } from './db'
import { problem, problemForError } from './problem'
import { replayGuard } from './replay-guard'

/** Twice the longest assertion life: a `jti` is remembered for as long as it could still verify. */
export const REPLAY_WINDOW_SECONDS = 120

/**
 * How long the OP should wait before trying again when the replay guard cannot answer. A claim
 * settles within about 2 s (`REPLAY_REDIS_OPTIONS.commandTimeout`), and ioredis's reconnect delay is
 * 2 s at most, so 5 s leaves room for at least one more reconnect attempt before the next claim.
 */
export const REPLAY_GUARD_RETRY_AFTER_SECONDS = '5'

/** One body for every refused assertion, whatever the reason, like the admin API's fixed 401. */
function refused(): Response {
  return problem(401, 'Unauthorized', 'the consent assertion was rejected', undefined, { 'www-authenticate': 'Bearer' })
}

export interface InternalContext {
  claims: ConsentClaims
  actor: Actor
}

/**
 * The internal routes' wrapper (M4 D7). The M2 posture, unchanged: bearer only, and a request that
 * also carries a session cookie is refused on its shape. The bearer must be an OP-signed consent
 * assertion; its `jti` is claimed once; its subject must be an active user with a known role
 * (`loadActiveActor`). Not listed in the OpenAPI document and not under `/api/admin`.
 */
export function withConsentAssertion(
  handler: (ctx: InternalContext) => Promise<Response>,
  opts: { requireGrant: boolean },
) {
  return async (req: Request): Promise<Response> => {
    const bearer = bearerOf(req)
    if (bearer && hasSessionCookie(req)) {
      return problem(400, 'Bad Request', 'a request may present a bearer token or a session cookie, never both')
    }
    if (!bearer) return refused()

    let claims: ConsentClaims
    try {
      claims = await verifyConsentAssertion(bearer, opts)
    } catch (e) {
      if (e instanceof KeySetUnavailableError) return problemForError(e)
      if (e instanceof TokenError) {
        // eslint-disable-next-line no-console
        console.warn(`[internal] consent assertion refused: ${e.reason}`)
        return refused()
      }
      throw e
    }
    // Fail closed (follow-up ruling F3): a jti that cannot be claimed is never honoured, and Redis being
    // unreachable is the service's fault, not the assertion's, so it is a 503 the OP may retry, not a 401.
    let first: boolean
    try {
      first = await (await replayGuard()).claimOnce(claims.jti, REPLAY_WINDOW_SECONDS)
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[internal] 503, the consent replay guard is unavailable:', e instanceof Error ? `${e.name}: ${e.message}` : String(e))
      return problem(
        503,
        'Service Unavailable',
        'the consent assertion cannot be checked right now; retry after the Retry-After interval',
        undefined,
        { 'retry-after': REPLAY_GUARD_RETRY_AFTER_SECONDS },
      )
    }
    if (!first) {
      // eslint-disable-next-line no-console
      console.warn('[internal] consent assertion refused: jti replayed')
      return refused()
    }

    const actor = await loadActiveActor(getDb(), claims.sub, `consent:${claims.clientId}:${claims.grantId ?? 'preflight'}`)
    if (!actor) return refused()

    try {
      return await handler({ claims, actor })
    } catch (e) {
      return problemForError(e)
    }
  }
}
