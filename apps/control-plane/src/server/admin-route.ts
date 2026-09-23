import type { Actor } from '../auth/authorize'
import { SESSION_COOKIE } from '../auth/session'
import { actorFromToken } from './admin-token'
import { publishConfigInvalidation } from './config-publisher'
import { getDb } from './db'
import { problem, problemForError, unauthorized } from './problem'

export interface AdminContext {
  actor: Actor
  req: Request
  params: Record<string, string>
}
export type AdminHandler = (ctx: AdminContext) => Promise<Response>

export interface AdminRouteOptions {
  /**
   * The config-invalidation reason this route publishes after a successful (2xx) response — the
   * same argument the console action performing the same service call passes, so the data plane
   * drops its cached config whichever surface made the change. Omit on routes that change nothing
   * the data plane caches (every GET). Published after the handler's service call has committed
   * and never on a refusal; `publishConfigInvalidation` never throws, so a failed publish cannot
   * turn a committed change into an error response (the data plane's cache TTL backstops it), which
   * is also how the console behaves.
   */
  invalidates?: string
}

/**
 * RFC 9110 §11.1: the auth scheme token is case-INsensitive, so a conforming client sending
 * `bearer <jwt>` must be admitted. `+` rather than a single space because the whitespace after the
 * scheme is also grammar, not part of the credential — capturing it would send a mangled token to
 * be verified, which then fails for entirely the wrong reason.
 */
const BEARER = /^Bearer +(.+)$/i

function bearerOf(req: Request): string | null {
  const h = req.headers.get('authorization')
  if (!h) return null
  const m = BEARER.exec(h)
  return m ? m[1]! : null
}

function hasSessionCookie(req: Request): boolean {
  const c = req.headers.get('cookie')
  return !!c && new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=`).test(c)
}

/**
 * The admin API is bearer-only with no cookie fallback (spec §3.2). Server actions get Next's
 * automatic Origin-vs-Host check; Route Handlers get nothing, so the CSRF posture is: a bearer and
 * NO ambient cookie. A request carrying both means a browser sent it — the confused-deputy shape.
 */
export function withAdmin(handler: AdminHandler, opts: AdminRouteOptions = {}) {
  return async (req: Request, ctx: { params: Promise<Record<string, string>> }): Promise<Response> => {
    const bearer = bearerOf(req)
    const cookie = hasSessionCookie(req)

    // Decided before verification: a request in this shape is refused on its shape alone, so
    // nothing about the token it carries is ever measured or revealed.
    if (bearer && cookie) {
      return problem(400, 'Bad Request',
        'a request may present a bearer token or a session cookie, never both')
    }
    if (!bearer) {
      return unauthorized(
        'the admin API requires a bearer access token; it does not accept a console session')
    }

    let actor: Actor
    try {
      actor = await actorFromToken(getDb(), bearer)
    } catch (e) {
      return problemForError(e)
    }

    let res: Response
    try {
      res = await handler({ actor, req, params: await ctx.params })
    } catch (e) {
      return problemForError(e)
    }
    if (opts.invalidates && res.ok) await publishConfigInvalidation(opts.invalidates)
    return res
  }
}
