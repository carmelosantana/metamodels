import type { Actor } from '../auth/authorize'
import { SESSION_COOKIE } from '../auth/session'
import { actorFromToken } from './admin-token'
import { getDb } from './db'
import { problem, problemForError } from './problem'

export interface AdminContext {
  actor: Actor
  req: Request
  params: Record<string, string>
}
export type AdminHandler = (ctx: AdminContext) => Promise<Response>

function bearerOf(req: Request): string | null {
  const h = req.headers.get('authorization')
  if (!h) return null
  const m = /^Bearer (.+)$/.exec(h)
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
export function withAdmin(handler: AdminHandler) {
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
      return problem(401, 'Unauthorized',
        'the admin API requires a bearer access token; it does not accept a console session')
    }

    let actor: Actor
    try {
      actor = await actorFromToken(getDb(), bearer)
    } catch (e) {
      return problemForError(e)
    }

    try {
      return await handler({ actor, req, params: await ctx.params })
    } catch (e) {
      return problemForError(e)
    }
  }
}
