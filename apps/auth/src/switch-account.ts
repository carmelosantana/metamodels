import type { Middleware } from 'koa'
import type { KoaContextWithOIDC } from 'oidc-provider'
import { renderSwitchAccountPage } from './device-views.js'
import { renderConsoleSwitchAccountPage } from './views.js'

/**
 * oidc-provider's two resume routes, each with the page shown for its account switch. Each is one
 * `GET` route (`GET /auth/:uid` and `GET /device/:uid`); its router serves `HEAD` on every `GET`
 * route, and matches the path case-insensitively and with one trailing slash stripped.
 */
const SWITCH_PAGES: Readonly<Record<string, (action: string, xsrf: string) => string>> = {
  // The console's sign-in, e.g. an invite: `login_hint` + `prompt=login` in a browser whose OP
  // session is another account's.
  resume: renderConsoleSwitchAccountPage,
  // A device approval: every one asks for a password (see `interactionPolicyWithFreshDeviceLogin`),
  // so a browser signed in as account A can submit account B's credentials.
  device_resume: renderSwitchAccountPage,
}

/**
 * Registered with `provider.use()`. Runs around every request and acts only on those oidc-provider
 * routed to `resume` or `device_resume`. It keys on `ctx.oidc.route`, which the router sets from the
 * matched route, not on the path.
 *
 * When account B has just signed in on a browser whose OP session is account A's, oidc-provider
 * will not resume as B while A's session is live. It saves a logout step in the session
 * (`state = { secret, clientId, postLogoutRedirectUri }`, the URI pointing back to this resume) and
 * renders an auto-submitting script page that posts `logout=yes` and that secret to its
 * logout-confirm endpoint. That POST ends A's session and redirects back here, and the resume then
 * continues as B. Our CSP blocks the script, and the `<noscript>` button does not show either,
 * because script is enabled but blocked, so the page would be blank. This keeps the library's
 * decision and its xsrf secret, and renders the same POST as our page with a button.
 *
 * It replaces the response only when both are true, and each excludes a case the other does not:
 * - the library's response carries the state's secret. Every writer makes a new random secret, so
 *   some state was written by this request. That excludes a stale state left by an earlier or
 *   abandoned request: the console's abandoned sign-out (end_session writes its own
 *   `post_logout_redirect_uri` there), or an abandoned switch, whose URI is this same resume's.
 * - the session's `postLogoutRedirectUri` is this resume's own URL, exactly as resume.js writes it.
 *   That excludes the other writer in this request: on any `device_resume` error, such as a missing
 *   or expired resume cookie (a reload of "Signed in" is one), oidc-provider's
 *   `lib/shared/error_handler.js` sets the state to `{ secret }` alone and re-renders
 *   `userCodeInputSource` with that secret in its xsrf input, so the secret check passes there.
 * Every other resume response passes through unchanged.
 */
export function switchAccountMiddleware(): Middleware {
  return async (ctx, next) => {
    await next()
    const { oidc } = ctx as unknown as Partial<KoaContextWithOIDC>
    const route = oidc?.route
    if (!oidc || !route || !Object.hasOwn(SWITCH_PAGES, route)) return
    const state = oidc.session?.state
    if (typeof state?.secret !== 'string') return
    // Exactly what resume.js writes for an account switch (`urlFor(route, ctx.params)`). The
    // error handler's `{ secret }` has no URI, so this rejects its re-render, which carries the
    // secret too.
    if (state.postLogoutRedirectUri !== oidc.urlFor(route, { uid: ctx.params.uid })) return
    // Some state was written by this request: resume.js's form_post (or the error handler's
    // form, excluded above) puts the secret in its xsrf input. The secret is a nanoid
    // (`[A-Za-z0-9_-]`), or hex from the error handler, which htmlSafe leaves as is. A stale
    // state's secret is not in this response.
    if (typeof ctx.body !== 'string' || !ctx.body.includes(`name="xsrf" value="${state.secret}"`)) return
    ctx.status = 200
    ctx.type = 'html'
    ctx.body = SWITCH_PAGES[route](oidc.urlFor('end_session_confirm'), state.secret)
  }
}
