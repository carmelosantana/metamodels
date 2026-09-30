import { randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { eq } from 'drizzle-orm'
import type { Middleware, ParameterizedContext } from 'koa'
import type Provider from 'oidc-provider'
import type { Grant, InteractionResults, KoaContextWithOIDC } from 'oidc-provider'
import { errors, interactionPolicy } from 'oidc-provider'
import { parseMcpResource, user } from '@metamodels/schema'
import { verifyLogin } from './account.js'
import { isCimdClient } from './cimd.js'
import { MINT_DENIED_PADDOCK, type ConsentApi, type ConsentRequest } from './consent-api.js'
import type { Db } from './db.js'
import type { LoginThrottle } from './login-throttle.js'
import { activeOauthKeyForGrant, findPaddock } from './paddocks.js'
import {
  AUTH_CSS, renderConsentPage, renderConsentRefusedPage, renderLoginPage, renderMessagePage, type ConsentView,
} from './views.js'

type Ctx = ParameterizedContext
type InteractionDetails = Awaited<ReturnType<Provider['interactionDetails']>>

export interface InteractionDeps {
  provider: Provider
  db: Db
  throttle: LoginThrottle
  /** Clients that ARE MetaModels, so consent is implied. */
  firstPartyClientIds: ReadonlySet<string>
  csp: string
  /** The control plane's internal oauth-keys routes (M4 D7). */
  consentApi: ConsentApi
  /** `DATA_PLANE_URL`, to recognise an MCP resource indicator. */
  dataPlaneUrl: string
}

/** What a client that is neither first-party nor a CIMD client asking for one MCP resource is told (M1). */
const NOT_PERMITTED = 'This client is not permitted to sign in yet.'

/** oidc-provider's route names for the browser half of the device grant: the confirm POST, and resuming after an interaction. */
const DEVICE_APPROVAL_ROUTES: ReadonlySet<string> = new Set(['code_verification', 'device_resume'])

/** What the MCP consent check reads: the database (read-only) and `DATA_PLANE_URL`. */
export interface McpKeyCheckDeps {
  db: Db
  dataPlaneUrl: string
}

/**
 * oidc-provider's default interaction policy plus two checks.
 *
 * Login: approving a device requires a password typed in THIS interaction (RFC 8628 §5.4, remote
 * phishing). An existing OP session does not count, however recent.
 *
 * `ctx.oidc.result` is the result of the interaction being resumed, and exists only on a resume
 * route. On the confirm POST (`code_verification`) there is none, so the login prompt always
 * fires. On `device_resume` it is what our handlers submitted for this interaction: `login` is
 * present only if the login form was submitted here (the consent step keeps it, since it merges
 * with the last submission). A login in another tab is a different interaction and leaves no
 * `result.login` here. oidc-provider's own `max_age` check uses the same test.
 *
 * Every other route (the console's authorization-code flow) skips the check, so its login
 * behaves as before.
 *
 * Consent (`mcp`, when given): a CIMD client asking for one MCP resource is asked again when the
 * grant it starts from has no active oauth key for that paddock. The browser session's grant keeps
 * its `mcp` scope after the key behind it is revoked (on the Keys page, by a role change, or by a
 * second approval rebinding the key to another grant), so oidc-provider's own scope checks would not
 * prompt, no key would be minted, and the code exchange would fail `invalid_grant`
 * (`makeExtraTokenClaims`) until the OP session ended. The consent screen's Approve mints a key onto
 * that same grant (`submitConsent`). The lookup only reads.
 */
export function interactionPolicyWithFreshDeviceLogin(mcp?: McpKeyCheckDeps): interactionPolicy.DefaultPolicy {
  const { Check, base } = interactionPolicy
  const policy = base()
  policy.get('login')!.checks.add(new Check(
    'device_fresh_login',
    'approving a device requires the password',
    (ctx) => DEVICE_APPROVAL_ROUTES.has(ctx.oidc.route) && !ctx.oidc.result?.login
      ? Check.REQUEST_PROMPT
      : Check.NO_NEED_TO_PROMPT,
  ))
  if (mcp) {
    policy.get('consent')!.checks.add(new Check(
      'mcp_key_missing',
      'the grant has no active key for this paddock',
      async (ctx) => {
        if (!isCimdClient(ctx.oidc.client)) return Check.NO_NEED_TO_PROMPT
        const resource = singleResource(ctx.oidc.params?.resource)
        const slug = resource === null ? null : parseMcpResource(mcp.dataPlaneUrl, resource)
        if (slug === null) return Check.NO_NEED_TO_PROMPT
        const grantId = ctx.oidc.grant?.jti
        if (!grantId) return Check.REQUEST_PROMPT
        return (await activeOauthKeyForGrant(mcp.db, grantId, slug)) ? Check.NO_NEED_TO_PROMPT : Check.REQUEST_PROMPT
      },
    ))
  }
  return policy
}

/**
 * `loadExistingGrant`: which grant an authorization request starts from. oidc-provider's default
 * takes the grant the consent step just handed back (`result.consent.grantId`), and failing that
 * the one the browser session already holds for the client (`session.grantIdFor(clientId)`).
 *
 * A device approval (`DEVICE_APPROVAL_ROUTES`) skips the session's grant, so every approval starts
 * from an empty grant: the consent prompt then lists every scope the device asked for, and
 * `consentFor` saves them in a new grant. One grant per approval is this project's decision, not
 * something RFC 8628 asks for: revoking a refresh token revokes its grant, so a grant shared by
 * every machine approved in one browser would let signing one machine out sign them all out. The
 * consent step's own grant is still taken: oidc-provider then records it as the session's
 * grant for the client, and binds the device code to that. The session so points at the newest
 * device grant. An older one is not revoked; it lives on for the refresh tokens issued under it.
 *
 * Every other route (the console's authorization-code flow, and MCP clients) keeps the default. An
 * MCP client's second paddock therefore extends the session's grant; its oauth keys are found per
 * (grant, paddock), never by the grant alone (`activeOauthKeyForGrant`).
 */
export async function loadExistingGrant(ctx: KoaContextWithOIDC): Promise<Grant | undefined> {
  const grantId = ctx.oidc.result?.consent?.grantId
    || (DEVICE_APPROVAL_ROUTES.has(ctx.oidc.route) ? undefined : ctx.oidc.session!.grantIdFor(ctx.oidc.client!.clientId))
  return grantId ? ctx.oidc.provider.Grant.find(grantId) : undefined
}

const INTERACTION_PATH = /^\/interaction\/([A-Za-z0-9_-]+)(\/login|\/consent)?$/
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
      if (ctx.method === 'POST' && match[2] === '/login') return await submitLogin(ctx, deps)
      if (ctx.method === 'POST' && match[2] === '/consent') return await submitConsent(ctx, deps)
      ctx.status = 405
      ctx.set('Allow', match[2] ? 'POST' : 'GET')
    } catch (err) {
      if (err instanceof errors.SessionNotFound) {
        html(ctx, 400, renderMessagePage(
          'Sign-in expired',
          'This sign-in attempt has expired or was already completed. Start the sign-in again from the console or your terminal.',
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
    if (deps.firstPartyClientIds.has(String(params.client_id))) {
      const consent = await consentFor(deps.provider, details)
      await deps.provider.interactionFinished(ctx.req, ctx.res, { consent }, { mergeWithLastSubmission: true })
      return
    }
    const mcp = await mcpConsent(deps, details)
    if (mcp.kind === 'not-mcp') {
      await deps.provider.interactionFinished(ctx.req, ctx.res, {
        error: 'access_denied', error_description: NOT_PERMITTED,
      }, { mergeWithLastSubmission: false })
      return
    }
    if (mcp.kind === 'no-paddock') {
      html(ctx, 200, renderConsentRefusedPage({ uid, reason: MINT_DENIED_PADDOCK, email: mcp.email, switchAccountHref: mcp.switchAccountHref }))
      return
    }
    // Asked before the page renders (spec §3.3), so a viewer never sees a button that would fail.
    const pre = await deps.consentApi.preflight(mcp.request)
    html(ctx, 200, pre.allowed
      ? renderConsentPage({ uid, ...mcp.view })
      : renderConsentRefusedPage({ uid, reason: pre.reason, email: mcp.view.email, switchAccountHref: mcp.view.switchAccountHref }))
    return
  }

  html(ctx, 400, renderMessagePage('Unsupported request', `This sign-in step (${prompt.name}) is not supported.`))
}

/**
 * What `mcpConsent` found: not an MCP consent at all (M1's refusal answers it); an MCP consent whose
 * paddock is unknown or disabled; or one to show.
 */
type McpConsent =
  | { kind: 'not-mcp' }
  | { kind: 'no-paddock'; email: string; switchAccountHref: string }
  | { kind: 'consent'; request: ConsentRequest; view: Omit<ConsentView, 'uid'> }

/** The one resource an MCP authorization request names, or null for none or several. */
function singleResource(v: unknown): string | null {
  if (typeof v === 'string') return v
  if (Array.isArray(v) && v.length === 1 && typeof v[0] === 'string') return v[0]
  return null
}

/**
 * This same authorization request with `prompt=login consent`: a fresh password prompt, after which
 * `switchAccountMiddleware` handles the account change on `resume` exactly as for the console, and
 * the consent screen comes back for the account that signed in. `consent` stays in the prompt so the
 * screen is shown even when the new account's grant already covers the request.
 */
function switchAccountHref(params: Record<string, unknown>): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (typeof v === 'string' && k !== 'prompt') q.set(k, v)
  q.set('prompt', 'login consent')
  return `/auth?${q}`
}

/**
 * The consent context of this interaction. A CIMD client asking for exactly one MCP resource is an MCP
 * consent; anything else is `not-mcp`. Everything shown is re-read here: the client from its document
 * (cached by oidc-provider), the paddock and the user's email from the database.
 *
 * `/auth` already refuses an unknown or disabled paddock (`invalid_target`, `resources.ts`), so
 * `no-paddock` is a paddock disabled or deleted after the request began. It is answered with the
 * words the control plane's preflight gives for a paddock in another org (`MINT_DENIED_PADDOCK`, the
 * twin of `PREFLIGHT_NO_PADDOCK`), on the same refusal page, so the screen cannot tell the two apart.
 */
async function mcpConsent(deps: InteractionDeps, details: InteractionDetails): Promise<McpConsent> {
  const client = await deps.provider.Client.find(String(details.params.client_id)).catch(() => undefined)
  if (!client || !isCimdClient(client)) return { kind: 'not-mcp' }
  const resource = singleResource(details.params.resource)
  const slug = resource === null ? null : parseMcpResource(deps.dataPlaneUrl, resource)
  if (resource === null || slug === null) return { kind: 'not-mcp' }

  const accountId = details.session?.accountId
  if (!accountId) throw new Error('consent prompt reached without an authenticated session')
  const rows = await deps.db.select({ email: user.email }).from(user).where(eq(user.id, accountId)).limit(1)
  const email = rows[0]?.email ?? ''
  const href = switchAccountHref(details.params)

  const paddock = await findPaddock(deps.db, slug)
  if (!paddock || paddock.status !== 'active') return { kind: 'no-paddock', email, switchAccountHref: href }

  const clientHost = new URL(client.clientId).host
  const clientName = client.clientName ?? clientHost
  return {
    kind: 'consent',
    request: { accountId, clientId: client.clientId, clientName, resource },
    view: {
      clientName,
      clientHost,
      redirectHost: new URL(String(details.params.redirect_uri)).host,
      paddockName: paddock.name,
      paddockSlug: paddock.slug,
      email,
      switchAccountHref: href,
    },
  }
}

/**
 * Approve, Deny or Close on the consent screen. Approve: mint first, then save the grant, so a grant
 * never exists without its key (spec §3.5). The grant id is chosen here, before the mint, because the
 * key is bound to it; an existing session grant keeps its id and gains the resource scope.
 */
async function submitConsent(ctx: Ctx, deps: InteractionDeps): Promise<void> {
  const details = await deps.provider.interactionDetails(ctx.req, ctx.res)
  if (details.prompt.name !== 'consent') {
    html(ctx, 400, renderMessagePage('Unsupported request', 'This sign-in step does not take an approval.'))
    return
  }
  const form = await readForm(ctx.req)
  if (form === null) {
    html(ctx, 413, renderMessagePage('Request too large', 'The approval form submission was too large.'))
    return
  }
  const fail = (result: InteractionResults) =>
    deps.provider.interactionFinished(ctx.req, ctx.res, result, { mergeWithLastSubmission: false })

  const mcp = await mcpConsent(deps, details)
  if (mcp.kind === 'not-mcp') return void await fail({ error: 'access_denied', error_description: NOT_PERMITTED })

  const decision = form.get('decision')
  if (mcp.kind === 'no-paddock') {
    // What the same decision gets for another org's paddock: Deny its usual answer; Approve (a screen
    // shown before the paddock went away) and Close the paddock reason, as the mint's 404 and preflight give it.
    return void await fail({
      error: 'access_denied',
      error_description: decision === 'deny' ? 'The request was denied.' : MINT_DENIED_PADDOCK,
    })
  }
  if (decision !== 'approve') {
    // Close follows a refusal: tell the client the same reason the user was shown.
    const pre = decision === 'close' ? await deps.consentApi.preflight(mcp.request) : undefined
    return void await fail({
      error: 'access_denied',
      error_description: pre && !pre.allowed ? pre.reason : 'The request was denied.',
    })
  }

  const existing = details.grantId ? await deps.provider.Grant.find(details.grantId) : undefined
  const grant = existing ?? new deps.provider.Grant({ accountId: mcp.request.accountId, clientId: mcp.request.clientId })
  if (!existing) grant.jti = randomBytes(16).toString('base64url')

  const minted = await deps.consentApi.mint({ ...mcp.request, grantId: grant.jti })
  if (!minted.ok) {
    if (minted.kind === 'error') {
      // eslint-disable-next-line no-console
      console.error(`[auth] recording an MCP approval failed: ${minted.detail}`)
      return void await fail({ error: 'server_error', error_description: 'MetaModels could not record this approval, so nothing was granted. Try again.' })
    }
    return void await fail({ error: 'access_denied', error_description: minted.reason })
  }

  addMissing(grant, details)
  await grant.save()
  await deps.provider.interactionFinished(ctx.req, ctx.res, {
    consent: existing ? {} : { grantId: grant.jti },
  }, { mergeWithLastSubmission: true })
}

/** Grant exactly what the request is missing, and nothing more: oidc-provider's reference handler, minus the screen. */
function addMissing(grant: Grant, details: InteractionDetails): void {
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
}

/**
 * Automatic consent for a first-party client: grant exactly what this request is missing, and
 * nothing more. Mirrors oidc-provider's reference consent handler, minus the screen.
 *
 * Which grant it writes to is decided by `details.grantId`, the saved grant the request started
 * from (see `loadExistingGrant`):
 * - Set (the console's authorization-code flow, when its browser session already holds a grant for
 *   the client): the missing scopes are added to that grant in place, and nothing is handed back.
 * - Unset: a NEW grant is saved and its id handed back, and the provider binds the request to it.
 *   Every device approval takes this branch: `loadExistingGrant` starts it from an unsaved grant,
 *   so it never carries the session's grant here, and the missing scopes are all it asked for.
 *   A device approval that did carry one is refused rather than given a shared grant.
 */
async function consentFor(provider: Provider, details: InteractionDetails): Promise<{ grantId?: string }> {
  const accountId = details.session?.accountId
  if (!accountId) throw new Error('consent prompt reached without an authenticated session')
  if (details.deviceCode !== undefined && details.grantId !== undefined) {
    throw new Error('device approval reached consent with an existing grant; each device gets its own')
  }

  const existing = details.grantId ? await provider.Grant.find(details.grantId) : undefined
  const grant = existing ?? new provider.Grant({ accountId, clientId: String(details.params.client_id) })
  addMissing(grant, details)
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
