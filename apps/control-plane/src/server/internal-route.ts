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
    if (!(await (await replayGuard()).claimOnce(claims.jti, REPLAY_WINDOW_SECONDS))) {
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
