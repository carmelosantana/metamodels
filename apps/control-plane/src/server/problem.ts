import { ZodError } from 'zod'
import { ForbiddenError } from '../auth/authorize'
import { KeySetUnavailableError, TokenError } from './admin-token'
import { NotFoundError } from './flocks-service'

/**
 * How long a client should wait before retrying an unreachable OP. 30s is not a guess: jose holds a
 * `JWKS_COOLDOWN_MS = 30_000` cooldown after a failed key-set fetch (`admin-token.ts`), so every
 * retry inside that window is answered from the same cached failure. Retrying sooner cannot succeed.
 */
const KEY_SET_RETRY_AFTER_SECONDS = '30'

/** RFC 9457 Problem Details. `type: 'about:blank'` per §4.2.1 when no dereferenceable type exists. */
export function problem(
  status: number,
  title: string,
  detail?: string,
  extra?: Record<string, unknown>,
  headers?: Record<string, string>,
): Response {
  const body: Record<string, unknown> = { type: 'about:blank', title, status }
  if (detail !== undefined) body.detail = detail
  return new Response(JSON.stringify({ ...body, ...extra }), {
    status,
    headers: { 'content-type': 'application/problem+json', ...headers },
  })
}

/**
 * The service layer's error vocabulary as HTTP. An unrecognised error is 500 with NO detail —
 * service errors can carry connection strings and upstream URLs, and this surface is reachable by
 * anything holding a token.
 *
 * Only `ForbiddenError` puts anything error-derived in the body, and only its `capability`: spec
 * §2.1 requires it, because a caller cannot fix a 403 without knowing which scope it lacks. Every
 * other arm answers with a fixed string. `TokenError.reason` in particular must never be echoed —
 * `'subject is not an active user'` distinguishes a valid token for a deactivated account from a
 * bad token, which is an account-enumeration oracle.
 */
export function problemForError(e: unknown): Response {
  if (e instanceof ForbiddenError) {
    return problem(403, 'Forbidden', e.message, { capability: e.capability })
  }
  if (e instanceof NotFoundError) return problem(404, 'Not Found', e.message)
  // Before the TokenError arm on purpose. The token was never judged — the fault is ours, and
  // answering 401 would send a client off to refresh a token that is probably fine, against an OP
  // that is down.
  if (e instanceof KeySetUnavailableError) {
    return problem(
      503,
      'Service Unavailable',
      'the authorization server is temporarily unreachable; retry shortly',
      undefined,
      { 'retry-after': KEY_SET_RETRY_AFTER_SECONDS },
    )
  }
  if (e instanceof TokenError) return problem(401, 'Unauthorized', 'the presented access token was rejected')
  if (e instanceof ZodError) {
    return problem(422, 'Unprocessable Content', 'request body failed validation', {
      errors: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    })
  }
  return problem(500, 'Internal Server Error')
}
