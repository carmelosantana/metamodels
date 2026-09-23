import { ZodError } from 'zod'
import { ForbiddenError } from '../auth/authorize'
import { KeySetUnavailableError, TokenError } from './admin-token'
import { NotFoundError } from './flocks-service'
import { SlugTakenError } from './paddocks-service'

/**
 * How long a client should wait before retrying a 503. 30 s is `JWKS_COOLDOWN_MS` (`admin-token.ts`).
 * For a `kid` missing from a set that is still cooling down, the cooldown ends within 30 s, and a
 * retry after it refetches unless another miss refetched first and started a new one. A failed fetch starts no cooldown (jose records the fetch time only on success),
 * so for an unreachable OP every request fetches again and 30 s only paces the client.
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
 * A 401 carrying the challenge RFC 9110 §15.5.2 makes MANDATORY on every 401 response — an HTTP
 * conformance rule, not an OAuth nicety.
 *
 * The bare scheme and nothing else. RFC 6750 §3 would let us add `error="invalid_token"` versus
 * `error="invalid_request"`, but that would restate in a header precisely the distinction the
 * `TokenError` arm's fixed `detail` refuses to make in the body, reopening the enumeration oracle.
 * Every 401 this API emits is built here, so the challenge cannot be forgotten on a new 401 and a
 * parameter cannot creep in on an old one.
 */
export function unauthorized(detail: string): Response {
  return problem(401, 'Unauthorized', detail, undefined, { 'www-authenticate': 'Bearer' })
}

/**
 * The server-side record of every admin-API 503: `KeySetUnavailableError` is thrown only by token
 * verification and answered only by `problemForError`, so it is logged here, once. Strings only,
 * as `logSignInFailure` does: the reason and the cause's name, `code` and message, never an error
 * object (jose errors can carry token claims) and never the token. The `code` is there because a
 * production build minifies jose's class names, so `name` alone can read `l`. CR and LF are replaced
 * so a message cannot forge a second log line.
 */
function logKeySetUnavailable(e: KeySetUnavailableError): void {
  const c = e.cause
  const rawCode = c instanceof Error ? (c as Error & { code?: unknown }).code : undefined
  const code = typeof rawCode === 'string' ? ` [${rawCode}]` : ''
  const cause = c === undefined ? 'no cause'
    : c instanceof Error ? `${c.name}${code}: ${c.message}` : String(c)
  console.error('[admin-api] 503, key set unavailable:', e.reason, cause.replace(/[\r\n]/g, ' '))
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
  // Before the TokenError arm on purpose. The token was not judged against a current key set, and
  // answering 401 would send a client off to refresh a token that may be fine. One fixed detail for
  // both causes (the key set could not be fetched, or it was fetched too recently to fetch again):
  // in the second the sign-in service is fine, so the detail must not say it is down, and naming
  // either cause would tell the caller more than it needs to retry.
  if (e instanceof KeySetUnavailableError) {
    logKeySetUnavailable(e)
    return problem(
      503,
      'Service Unavailable',
      'the access token cannot be verified right now; retry after the Retry-After interval',
      undefined,
      { 'retry-after': KEY_SET_RETRY_AFTER_SECONDS },
    )
  }
  if (e instanceof TokenError) return unauthorized('the presented access token was rejected')
  if (e instanceof SlugTakenError) return problem(409, 'Conflict', e.message)
  /**
   * `detail` deliberately does NOT name the body. `ZodError` reaches here from three places now —
   * `readJsonObject` (a body), `parsePathId` (a path segment) and the usage reports' query schemas
   * (a query string) — and `GET /flocks/my-flock` carries no body at all. A detail saying otherwise
   * would contradict the `errors[]` array sitting beside it in the same response.
   *
   * Not derived from the issue paths either, which is the tempting alternative: nothing in a
   * `ZodError` records which source threw it, and the paths are genuinely ambiguous — `POST /flocks`
   * accepts an `id` IN THE BODY, so `path: ['id']` alone cannot tell a bad path segment from a bad
   * body field. Guessing would trade a detail that is wrong on 17 surfaces for one that is wrong
   * occasionally and unpredictably. `errors[]` is the precise, machine-readable half; `detail` is
   * the half whose only job is not to lie.
   */
  if (e instanceof ZodError) {
    return problem(422, 'Unprocessable Content', 'request failed validation', {
      errors: e.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    })
  }
  // An unmapped service error silently becomes an opaque 500 with no detail — unfixable by the
  // caller and indistinguishable from a real outage. `users-service`'s LastAdminError /
  // SelfActionError / SeatLimitError, the invite errors and NotAdminError are unmapped because no
  // route in M2 reaches them. Exposing users or invites means adding their arms above, first.
  return problem(500, 'Internal Server Error')
}
