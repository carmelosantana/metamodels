import type { IncomingMessage } from 'node:http'
import type { Middleware, ParameterizedContext } from 'koa'
import type Provider from 'oidc-provider'
import { errors } from 'oidc-provider'
import { verifyLogin } from './account.js'
import type { Db } from './db.js'
import type { LoginThrottle } from './login-throttle.js'
import { AUTH_CSS, renderLoginPage, renderMessagePage } from './views.js'

type Ctx = ParameterizedContext
type InteractionDetails = Awaited<ReturnType<Provider['interactionDetails']>>

export interface InteractionDeps {
  provider: Provider
  db: Db
  throttle: LoginThrottle
  /** Clients that ARE MetaModels, so consent is implied. Everyone else is refused until M4's consent screen. */
  firstPartyClientIds: ReadonlySet<string>
  csp: string
}

const INTERACTION_PATH = /^\/interaction\/([A-Za-z0-9_-]+)(\/login)?$/
const MAX_FORM_BYTES = 16 * 1024

function html(ctx: Ctx, status: number, body: string): void {
  ctx.status = status
  ctx.type = 'html'
  ctx.body = body
}

/**
 * Registered with `provider.use()`, so it runs before oidc-provider's own routes. Sets security
 * headers on EVERY response, serves the health check and stylesheet, and owns /interaction/*.
 * Everything else falls through to oidc-provider.
 */
export function interactionMiddleware(deps: InteractionDeps): Middleware {
  return async (ctx, next) => {
    ctx.set('Content-Security-Policy', deps.csp)
    ctx.set('X-Content-Type-Options', 'nosniff')
    ctx.set('X-Frame-Options', 'DENY')
    ctx.set('Referrer-Policy', 'no-referrer')
    // Inert over plain HTTP; takes effect once TLS terminates in front of the service.
    ctx.set('Strict-Transport-Security', 'max-age=63072000')

    if (ctx.method === 'GET' && ctx.path === '/healthz') {
      ctx.body = { ok: true }
      return
    }
    if (ctx.method === 'GET' && ctx.path === '/assets/auth.css') {
      ctx.type = 'text/css'
      ctx.set('Cache-Control', 'public, max-age=3600')
      ctx.body = AUTH_CSS
      return
    }

    const match = INTERACTION_PATH.exec(ctx.path)
    if (!match) return next()
    ctx.set('Cache-Control', 'no-store')
    try {
      if (ctx.method === 'GET' && !match[2]) return await showInteraction(ctx, deps)
      if (ctx.method === 'POST' && match[2]) return await submitLogin(ctx, deps)
      ctx.status = 405
      ctx.set('Allow', match[2] ? 'POST' : 'GET')
    } catch (err) {
      if (err instanceof errors.SessionNotFound) {
        html(ctx, 400, renderMessagePage(
          'Sign-in expired',
          'This sign-in attempt has expired or was already completed. Go back to the console and sign in again.',
        ))
        return
      }
      throw err
    }
  }
}

async function showInteraction(ctx: Ctx, deps: InteractionDeps): Promise<void> {
  const details = await deps.provider.interactionDetails(ctx.req, ctx.res)
  const { uid, prompt, params } = details

  if (prompt.name === 'login') {
    const hint = typeof params.login_hint === 'string' ? params.login_hint : undefined
    html(ctx, 200, renderLoginPage({ uid, email: hint }))
    return
  }

  if (prompt.name === 'consent') {
    if (!deps.firstPartyClientIds.has(String(params.client_id))) {
      await deps.provider.interactionFinished(ctx.req, ctx.res, {
        error: 'access_denied',
        error_description: 'This client is not permitted to sign in yet.',
      }, { mergeWithLastSubmission: false })
      return
    }
    const consent = await consentFor(deps.provider, details)
    await deps.provider.interactionFinished(ctx.req, ctx.res, { consent }, { mergeWithLastSubmission: true })
    return
  }

  html(ctx, 400, renderMessagePage('Unsupported request', `This sign-in step (${prompt.name}) is not supported.`))
}

/**
 * Automatic consent for a first-party client: grant exactly what this request is missing, and
 * nothing more. Mirrors oidc-provider's reference consent handler, minus the screen.
 */
async function consentFor(provider: Provider, details: InteractionDetails): Promise<{ grantId?: string }> {
  const accountId = details.session?.accountId
  if (!accountId) throw new Error('consent prompt reached without an authenticated session')

  const existing = details.grantId ? await provider.Grant.find(details.grantId) : undefined
  const grant = existing ?? new provider.Grant({ accountId, clientId: String(details.params.client_id) })

  const missing = details.prompt.details as {
    missingOIDCScope?: string[]
    missingOIDCClaims?: string[]
    missingResourceScopes?: Record<string, string[]>
  }
  if (missing.missingOIDCScope) grant.addOIDCScope(missing.missingOIDCScope.join(' '))
  if (missing.missingOIDCClaims) grant.addOIDCClaims(missing.missingOIDCClaims)
  for (const [resource, scopes] of Object.entries(missing.missingResourceScopes ?? {})) {
    grant.addResourceScope(resource, scopes.join(' '))
  }

  const grantId = await grant.save()
  // An existing grant is modified in place; only a new one is handed back to the provider.
  return details.grantId ? {} : { grantId }
}

async function submitLogin(ctx: Ctx, deps: InteractionDeps): Promise<void> {
  const details = await deps.provider.interactionDetails(ctx.req, ctx.res)
  if (details.prompt.name !== 'login') {
    html(ctx, 400, renderMessagePage('Unsupported request', 'This sign-in step does not accept a password.'))
    return
  }

  const form = await readForm(ctx.req)
  if (form === null) {
    html(ctx, 413, renderMessagePage('Request too large', 'The sign-in form submission was too large.'))
    return
  }
  const email = (form.get('email') ?? '').trim()
  const password = form.get('password') ?? ''
  // provider.proxy = true, so ctx.ip is the first X-Forwarded-For hop — the throttle is only
  // meaningful behind a trusted proxy (docs/DEPLOY.md, "Deploy gotchas"), exactly as it was in the console.
  const ip = ctx.ip || 'unknown'
  const now = Date.now()

  if (!deps.throttle.check(ip, now)) {
    html(ctx, 429, renderLoginPage({ uid: details.uid, email, error: 'Too many attempts. Try again later.' }))
    return
  }
  const result = await verifyLogin(deps.db, email, password)
  if (!result.ok) {
    deps.throttle.record(ip, now)
    const error = result.reason === 'deactivated' ? 'This account is deactivated.' : 'Invalid email or password.'
    html(ctx, 401, renderLoginPage({ uid: details.uid, email, error }))
    return
  }
  await deps.provider.interactionFinished(ctx.req, ctx.res, {
    login: { accountId: result.accountId },
  }, { mergeWithLastSubmission: false })
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > MAX_FORM_BYTES) return null
    chunks.push(buf)
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}
