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
 * If either lookup fails, the static policy stays and the failure is logged (follow-up ruling F4).
 */
export function cimdCspMiddleware(opts: { provider: Provider; consoleOrigin: string }): Middleware {
  return async (ctx, next) => {
    await next()
    if (!ctx.response.is('html')) return
    const match = INTERACTION_PAGE.exec(ctx.path)
    if (!match) return
    let origin: string | null
    try {
      origin = await cimdRedirectOrigin(opts.provider, match[1]!)
    } catch (e) {
      // The page is built and already carries the static policy: a failed lookup (the adapter's
      // database, a CIMD document refetch) only means form-action is not widened. The hand-back
      // redirect may then be blocked, which the user can retry; a 500 in place of the page could not be.
      // eslint-disable-next-line no-console
      console.warn(`[auth] form-action not widened for ${ctx.path}: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    if (origin !== null) ctx.set('Content-Security-Policy', authCsp([opts.consoleOrigin, origin]))
  }
}

/** The validated `redirect_uri` origin of interaction `uid`, when its client is a CIMD client; else null. May throw. */
async function cimdRedirectOrigin(provider: Provider, uid: string): Promise<string | null> {
  const interaction = await provider.Interaction.find(uid)
  if (!interaction) return null
  const { client_id: clientId, redirect_uri: redirectUri } = interaction.params as Record<string, unknown>
  if (typeof clientId !== 'string' || typeof redirectUri !== 'string') return null
  const client = await provider.Client.find(clientId)
  if (!client || !isCimdClient(client) || !client.redirectUriAllowed(redirectUri)) return null
  const origin = new URL(redirectUri).origin
  return origin === 'null' ? null : origin
}
