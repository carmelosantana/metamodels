import type { Middleware } from 'koa'
import type Provider from 'oidc-provider'
import { isCimdClient } from './cimd.js'
import { authCsp } from './views.js'

/** The two paths whose HTML belongs to an interaction: our `/interaction/:uid…` pages, and oidc-provider's `resume` (`/auth/:uid`). */
const INTERACTION_PAGE = /^\/(?:interaction|auth)\/([A-Za-z0-9_-]+)/

/**
 * Registered with `provider.use()` BEFORE `interactionMiddleware`, so it wraps it: it runs after the
 * response is built and may rewrite its CSP. On the pattern of `switchAccountMiddleware`.
 *
 * `authCsp` is computed once, from the console origin. After a CIMD client's login or consent, the
 * browser is redirected to that client's `redirect_uri`, whose origin is in no static list; browsers
 * apply the submitting page's `form-action` to the redirects that follow, so the static header would
 * block the hand-back. For an HTML response on an interaction whose client is a CIMD client, this
 * appends that interaction's `redirect_uri` origin — validated by oidc-provider at `/auth`, and
 * re-checked against the client here — to `form-action`. Nothing else changes, on any response.
 */
export function cimdCspMiddleware(opts: { provider: Provider; consoleOrigin: string }): Middleware {
  return async (ctx, next) => {
    await next()
    if (!ctx.response.is('html')) return
    const match = INTERACTION_PAGE.exec(ctx.path)
    if (!match) return
    const interaction = await opts.provider.Interaction.find(match[1]!)
    if (!interaction) return
    const { client_id: clientId, redirect_uri: redirectUri } = interaction.params as Record<string, unknown>
    if (typeof clientId !== 'string' || typeof redirectUri !== 'string') return
    const client = await opts.provider.Client.find(clientId).catch(() => undefined)
    if (!client || !isCimdClient(client) || !client.redirectUriAllowed(redirectUri)) return
    const origin = new URL(redirectUri).origin
    if (origin === 'null') return
    ctx.set('Content-Security-Policy', authCsp([opts.consoleOrigin, origin]))
  }
}
