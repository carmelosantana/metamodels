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
 * Registered with `provider.use()`, so it runs before oidc-provider's routes. Handles exactly one
 * request shape: `GET /device?user_code=…`.
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
    if (ctx.method === 'GET' && ctx.path === DEVICE_VERIFICATION_PATH) {
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

const DEVICE_RESUME_PATH = new RegExp(`^${DEVICE_VERIFICATION_PATH}/[A-Za-z0-9_-]+$`)

/**
 * Registered with `provider.use()`. Handles exactly `GET /device/:uid` (oidc-provider's
 * `device_resume`), and changes its response in one case only.
 *
 * Every device approval asks for a password (see `interactionPolicyWithFreshDeviceLogin`), so a
 * browser signed in as account A can now submit account B's credentials. On resume, oidc-provider
 * will not continue as B while A's session is live. It saves a logout step in the session
 * (`state.postLogoutRedirectUri`, pointing back to this resume) and renders an auto-submitting
 * script page that posts `logout=yes` to its logout-confirm endpoint. That POST ends A's session and
 * redirects back here, and the resume then continues as B. Our CSP blocks the script, so the page
 * would be blank. This keeps the library's decision and its xsrf secret, and renders the same POST
 * as our page with a button.
 */
export function deviceSwitchAccountMiddleware(): Middleware {
  return async (ctx, next) => {
    if (ctx.method !== 'GET' || !DEVICE_RESUME_PATH.test(ctx.path)) return next()
    await next()
    const { oidc } = ctx as unknown as Partial<KoaContextWithOIDC>
    if (oidc?.route !== 'device_resume') return
    const state = oidc.session?.state
    if (typeof state?.postLogoutRedirectUri !== 'string' || typeof state.secret !== 'string') return
    ctx.status = 200
    ctx.type = 'html'
    ctx.body = renderSwitchAccountPage(oidc.urlFor('end_session_confirm'), state.secret)
  }
}
