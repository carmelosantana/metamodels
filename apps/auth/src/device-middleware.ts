import type { Middleware } from 'koa'

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

