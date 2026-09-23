import type { Middleware } from 'koa'
import type { KoaContextWithOIDC } from 'oidc-provider'
import { renderSwitchAccountPage } from './device-views.js'

/** oidc-provider's `code_verification` route: the RFC 8628 verification URI. Set in `routes`. */
export const DEVICE_VERIFICATION_PATH = '/device'

const prefills = new WeakMap<object, string>()

/**
 * The user code from `verification_uri_complete`, taken off this request by
 * `devicePrefillMiddleware`, for `userCodeInputSource` to show filled in. Undefined otherwise.
 */
export function prefilledUserCode(ctx: object): string | undefined {
  return prefills.get(ctx)
}

/**
 * The request paths oidc-provider's router (`lib/helpers/router.js`) sends to `code_verification`.
 * It compares paths case-insensitively: its `fold` uppercases but never maps a non-ASCII character
 * onto ASCII, which is what a non-unicode `i` regex does too. If there is no exact match, it strips one
 * trailing slash and tries again. (`DEVICE_VERIFICATION_PATH` has no regex metacharacters.)
 */
const DEVICE_VERIFICATION_ROUTE = new RegExp(`^${DEVICE_VERIFICATION_PATH}/?$`, 'i')

/**
 * Registered with `provider.use()`, so it runs before oidc-provider's routes. Handles exactly one
 * request shape: `GET /device?user_code=…`, in every spelling the router accepts for that route
 * (`DEVICE_VERIFICATION_ROUTE`, and `HEAD`, which the router serves on every `GET` route).
 *
 * oidc-provider answers that with its auto-submitting form_post page, whose inline script our CSP
 * (`default-src 'none'`, no `script-src`) blocks. The `<noscript>` button does not show either,
 * because script is enabled but blocked, so the operator sees a blank page. The library has no
 * option for that page. So the code is moved off the query here, and oidc-provider serves its plain
 * `GET /device` instead: a fresh xsrf token in the session and `userCodeInputSource`, which shows
 * the code filled in. Continue then posts the provider's own form, so the xsrf check still applies.
 */
export function devicePrefillMiddleware(): Middleware {
  return async (ctx, next) => {
    if ((ctx.method === 'GET' || ctx.method === 'HEAD') && DEVICE_VERIFICATION_ROUTE.test(ctx.path)) {
      const query = new URLSearchParams(ctx.querystring)
      const code = query.get('user_code')
      if (code !== null) {
        query.delete('user_code')
        ctx.querystring = query.toString()
        if (code) prefills.set(ctx, code)
      }
    }
    return next()
  }
}

/**
 * Registered with `provider.use()`. Runs around every request and acts only on those oidc-provider
 * routed to `device_resume` (`GET` or `HEAD /device/:uid`, in any spelling its router accepts). It keys on
 * `ctx.oidc.route`, which the router sets from the matched route, not on the path.
 *
 * Every device approval asks for a password (see `interactionPolicyWithFreshDeviceLogin`), so a
 * browser signed in as account A can now submit account B's credentials. On resume, oidc-provider
 * will not continue as B while A's session is live. It saves a logout step in the session
 * (`state = { secret, clientId, postLogoutRedirectUri }`, the URI pointing back to this resume) and
 * renders an auto-submitting script page that posts `logout=yes` and that secret to its
 * logout-confirm endpoint. That POST ends A's session and redirects back here, and the resume then
 * continues as B. Our CSP blocks the script, so the page would be blank. This keeps the library's
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
export function deviceSwitchAccountMiddleware(): Middleware {
  return async (ctx, next) => {
    await next()
    const { oidc } = ctx as unknown as Partial<KoaContextWithOIDC>
    if (oidc?.route !== 'device_resume') return
    const state = oidc.session?.state
    if (typeof state?.secret !== 'string') return
    // Exactly what resume.js writes for an account switch (`urlFor(route, ctx.params)`). The
    // error handler's `{ secret }` has no URI, so this rejects its re-render, which carries the
    // secret too.
    if (state.postLogoutRedirectUri !== oidc.urlFor('device_resume', { uid: ctx.params.uid })) return
    // Some state was written by this request: resume.js's form_post (or the error handler's
    // form, excluded above) puts the secret in its xsrf input. The secret is a nanoid
    // (`[A-Za-z0-9_-]`), or hex from the error handler, which htmlSafe leaves as is. A stale
    // state's secret is not in this response.
    if (typeof ctx.body !== 'string' || !ctx.body.includes(`name="xsrf" value="${state.secret}"`)) return
    ctx.status = 200
    ctx.type = 'html'
    ctx.body = renderSwitchAccountPage(oidc.urlFor('end_session_confirm'), state.secret)
  }
}
