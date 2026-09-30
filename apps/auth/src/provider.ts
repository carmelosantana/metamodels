import Provider, { errors, type ClientMetadata, type Configuration } from 'oidc-provider'
import { CLI_CLIENT_ID, CONSOLE_CLIENT_ID, OPERATOR_SESSION_TTL_MS } from '@metamodels/schema'
import { makeFindAccount } from './account.js'
import { cimdFeature, cimdGateForIssuer, ssrfGuardAvailable } from './cimd.js'
import { cimdCspMiddleware } from './cimd-csp.js'
import { consentAsserter, httpConsentApi, type ConsentApi } from './consent-api.js'
import { pgAdapterFactory } from './adapter.js'
import type { AuthConfig } from './config.js'
import type { Db } from './db.js'
import { interactionMiddleware, interactionPolicyWithFreshDeviceLogin, loadExistingGrant } from './interactions.js'
import { signingJwks } from './keys.js'
import { LoginThrottle } from './login-throttle.js'
import { findPaddock } from './paddocks.js'
import {
  accessTokenTtl, makeExtraTokenClaims, makeGetResourceServerInfo, mcpRefreshPolicy, resourcesByClient, resourceServers,
} from './resources.js'
import { switchAccountMiddleware } from './switch-account.js'
import { DEVICE_VERIFICATION_PATH, devicePrefillMiddleware, prefilledUserCode } from './device-middleware.js'
import { renderDeviceConfirmPage, renderUserCodePage } from './device-views.js'
import { authCsp, renderLogoutPage, renderMessagePage } from './views.js'

/** How long a device code (and the user code shown beside it) stays redeemable. */
export const DEVICE_CODE_TTL = 10 * 60

/** Idle window: a refresh token unused for this long is dead (spec §4.4, ~30 days). */
export const REFRESH_TOKEN_IDLE_TTL = 30 * 24 * 60 * 60

/**
 * Absolute cap: no refresh-token chain outlives this, measured from the chain's FIRST token, however
 * often it is used (spec §4.4, ~90 days). After it the CLI must sign in again.
 */
export const REFRESH_TOKEN_ABSOLUTE_TTL = 90 * 24 * 60 * 60

/**
 * `ttl.RefreshToken`: the idle window, clamped so the token cannot outlive its chain's absolute cap.
 *
 * Why here and not in `rotateRefreshToken`: that option only answers "rotate or not" — it receives
 * `ctx` alone and returns a boolean — and when it declines, oidc-provider's refresh_token grant simply
 * reuses the presented token, unconsumed, until that token's own `exp` (its default policy stops
 * rotating after a year in exactly this way). A cap there would really be cap + idle window, and
 * would switch off reuse detection for the tail of the chain. A TTL is evaluated as each refresh
 * token is saved — on first issue and on every rotation — so clamping it bounds the chain exactly.
 *
 * `token` is the refresh token being saved (the provider has already set it as
 * `ctx.oidc.entities.RefreshToken`). Its `iiat` is the chain's first issue time: oidc-provider sets
 * it once, when the first token is built, and copies it verbatim into each rotated successor —
 * whereas `iat` is each token's own issue time and would make a cap renew forever.
 *
 * A chain already at the cap cannot reach here through a live token (every token in it expires by
 * `iiat + cap`); refusing rather than returning a non-positive TTL keeps that true if it ever could.
 */
export function refreshTokenTtl(_ctx: unknown, token: { iiat?: number }): number {
  if (typeof token.iiat !== 'number') throw new errors.InvalidGrant('refresh token has no chain start')
  const now = Math.floor(Date.now() / 1000)
  const left = token.iiat + REFRESH_TOKEN_ABSOLUTE_TTL - now
  if (left <= 0) throw new errors.InvalidGrant('refresh token reached its absolute lifetime')
  return Math.min(REFRESH_TOKEN_IDLE_TTL, left)
}

export interface ProviderOptions {
  /**
   * More statically registered clients. Never auto-consented (M1 refuses them at the consent
   * prompt), and granted no resource: absent from `resourcesByClient`, they get `invalid_target`.
   */
  extraClients?: readonly ClientMetadata[]
  /**
   * Replaces oidc-provider's outbound fetch. Tests and the e2e OP answer CIMD documents through it
   * (`cimdFixtureFetch`); production leaves it unset.
   */
  fetch?: Configuration['fetch']
  /** Whether the SSRF guard is installed. Injectable so the boot refusal can be tested. */
  ssrfGuardAvailable?: () => boolean
  /** The control plane's oauth-keys routes. Defaults to HTTP over `cfg.controlPlaneInternalUrl`; tests inject a fake. */
  consentApi?: ConsentApi
}

/** The operator console — a confidential client using the authorization-code flow with PKCE. */
export function consoleClient(cfg: AuthConfig): ClientMetadata {
  return {
    client_id: CONSOLE_CLIENT_ID,
    client_secret: cfg.consoleClientSecret,
    client_name: 'MetaModels console',
    redirect_uris: [`${cfg.consoleUrl}/auth/callback`],
    post_logout_redirect_uris: [`${cfg.consoleUrl}/login`],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_basic',
  }
}

/**
 * The admin CLI — a PUBLIC client: nothing shipped to an operator's laptop can hold a secret. Device
 * grant and refresh only, so it has no redirect URI and no authorization-endpoint response type.
 */
export function cliClient(): ClientMetadata {
  return {
    client_id: CLI_CLIENT_ID,
    client_name: 'MetaModels admin CLI',
    token_endpoint_auth_method: 'none',
    grant_types: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
    response_types: [],
    redirect_uris: [],
    application_type: 'native',
  }
}

export function createProvider(cfg: AuthConfig, db: Db, opts: ProviderOptions = {}): Provider {
  const cimd = cimdGateForIssuer(cfg.issuer)
  if (cimd.enabled && !(opts.ssrfGuardAvailable ?? ssrfGuardAvailable)()) {
    throw new Error(
      'Client ID Metadata Documents need oidc-provider\'s SSRF guard, and it is not installed (no undici ' +
      'global dispatcher). Refusing to start rather than fetch client documents unguarded.')
  }
  if (!cimd.enabled) {
    // eslint-disable-next-line no-console
    console.warn(`[auth] Client ID Metadata Documents are off: ${cimd.reason}`)
  }
  const refresh = mcpRefreshPolicy(cfg.dataPlaneUrl)
  const jwks = signingJwks(cfg.signingKeyPem, cfg.allowEphemeralKey, cfg.previousSigningKeyPems)
  const consentApi = opts.consentApi ?? httpConsentApi({
    baseUrl: cfg.controlPlaneInternalUrl,
    // The first key is the one oidc-provider signs with (see `signingJwks`); the control plane
    // verifies the assertion against the same published JWKS.
    assert: consentAsserter({ issuer: cfg.issuer, consoleUrl: cfg.consoleUrl, signingJwk: jwks.keys[0]! }),
  })
  const configuration: Configuration = {
    adapter: pgAdapterFactory(db),
    clients: [consoleClient(cfg), cliClient(), ...(opts.extraClients ?? [])],
    cookies: { keys: cfg.cookieKeys },
    jwks,
    findAccount: makeFindAccount(db),
    extraTokenClaims: makeExtraTokenClaims(db, cfg.dataPlaneUrl) as NonNullable<Configuration['extraTokenClaims']>,
    // Ruling R4: MCP clients get refresh tokens without offline_access; everyone else keeps the defaults.
    issueRefreshToken: refresh.issueRefreshToken as NonNullable<Configuration['issueRefreshToken']>,
    expiresWithSession: refresh.expiresWithSession as NonNullable<Configuration['expiresWithSession']>,
    // OAuth 2.1: PKCE for every client, confidential ones included.
    pkce: { required: () => true },
    interactions: {
      url: (_ctx, interaction) => `/interaction/${interaction.uid}`,
      policy: interactionPolicyWithFreshDeviceLogin(),
    },
    // A new grant for every device approval; the console keeps the default (see loadExistingGrant).
    loadExistingGrant,
    // The library default, named so devicePrefillMiddleware matches the path this route is served
    // on. (switchAccountMiddleware keys on the matched route names, resume and device_resume, not
    // on a path.)
    routes: { code_verification: DEVICE_VERIFICATION_PATH },
    features: {
      devInteractions: { enabled: false },
      clientIdMetadataDocument: cimd.enabled ? cimdFeature() : { enabled: false },
      resourceIndicators: {
        enabled: true,
        getResourceServerInfo: makeGetResourceServerInfo(resourceServers(cfg.consoleUrl), resourcesByClient(cfg.consoleUrl), {
          dataPlaneUrl: cfg.dataPlaneUrl,
          isActivePaddock: async (slug) => (await findPaddock(db, slug))?.status === 'active',
        }),
        // Clients must name the resource at the token endpoint as well; an openid-only exchange
        // returns an opaque userinfo token, never a resource-bound JWT.
        useGrantedResource: async () => false,
      },
      deviceFlow: {
        enabled: true,
        userCodeInputSource: (ctx, form, _out, err) => {
          ctx.type = 'html'
          ctx.body = renderUserCodePage(form, err, prefilledUserCode(ctx))
        },
        // deviceInfo is the library default: the CLI's ip and user agent, taken at /device/auth.
        userCodeConfirmSource: (ctx, form, client, deviceInfo, userCode) => {
          ctx.type = 'html'
          ctx.body = renderDeviceConfirmPage(form, client.clientName ?? client.clientId, userCode, deviceInfo)
        },
        successSource: (ctx) => {
          ctx.type = 'html'
          ctx.body = renderMessagePage('Signed in', 'You can close this page and return to your terminal.')
        },
      },
      // RFC 7009, for `mm logout`: the CLI revokes its refresh token, and with it the grant. (Access
      // tokens are JWTs, which this endpoint refuses and the admin API verifies offline — they run
      // out their own lifetime.)
      revocation: {
        enabled: true,
        // A client revokes only its own tokens. Someone else's is answered exactly like a
        // revocation (200, token untouched), so the endpoint confirms nothing about a token it was
        // handed. The library default does the same for a public client but answers a confidential
        // one with invalid_request, and asks to be replaced ("you SHOULD change it") on first use.
        allowedPolicy: (_ctx, client, token) => token.clientId === client.clientId,
      },
      rpInitiatedLogout: {
        enabled: true,
        logoutSource: (ctx, form) => {
          ctx.type = 'html'
          ctx.body = renderLogoutPage(form)
        },
        postLogoutSuccessSource: (ctx) => {
          ctx.type = 'html'
          ctx.body = renderMessagePage('Signed out', 'You have been signed out of MetaModels.')
        },
      },
    },
    // Every use of a refresh token issues a new one and consumes its predecessor; presenting a
    // consumed one revokes the whole grant, so reuse of a stolen token is detected (spec §4.4).
    // The CLI and MCP (CIMD) clients hold refresh tokens; the console's client metadata has no
    // refresh_token grant.
    rotateRefreshToken: true,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    renderError: (ctx, out) => {
      ctx.type = 'html'
      ctx.body = renderMessagePage('Sign-in error', out.error_description ?? out.error)
    },
    ttl: {
      // A function, not a number: only this shape lets a resource server's accessTokenTTL govern.
      AccessToken: accessTokenTtl,
      AuthorizationCode: 60,
      IdToken: 60 * 60,
      Interaction: 10 * 60,
      // Never longer than the console session: the OP session cookie is persistent (login results
      // are remembered), so a longer OP session would silently sign the browser back in, with no
      // password, after the console session ends.
      Session: OPERATOR_SESSION_TTL_MS / 1000,
      DeviceCode: DEVICE_CODE_TTL,
      // Idle window clamped to the absolute cap — see refreshTokenTtl.
      RefreshToken: refreshTokenTtl,
      // Every refresh re-validates the grant, so the grant must outlive every refresh token issued
      // under it or its expiry, not the refresh-token policy, becomes the real bound. Every device
      // approval saves a new grant at consent (see loadExistingGrant), at most one device-code
      // lifetime before its first refresh token.
      // For the console (no refresh tokens) a grant without a live OP session signs no one in, so
      // the long lifetime is harmless there.
      Grant: REFRESH_TOKEN_ABSOLUTE_TTL + DEVICE_CODE_TTL,
    },
  }

  const provider = new Provider(cfg.issuer, configuration)
  // Deployed behind a TLS-terminating proxy or tunnel: trust X-Forwarded-Proto/For so issued URLs
  // and cookie `secure` flags are right (oidc-provider docs, "Trusting TLS offloading proxies").
  provider.proxy = true
  const consoleOrigin = new URL(cfg.consoleUrl).origin
  // First, so it wraps everything below and sees each response last.
  provider.use(cimdCspMiddleware({ provider, consoleOrigin }))
  provider.use(interactionMiddleware({
    provider,
    db,
    throttle: new LoginThrottle(),
    // Auto-consented without a consent screen (spec A16). Every other client is refused at
    // consent, except a CIMD client asking for one MCP resource, which gets the consent screen
    // (M4 §4.3). Not a grant of the admin API: that is `resourcesByClient`, where only the CLI is
    // listed (spec A15).
    firstPartyClientIds: new Set([CONSOLE_CLIENT_ID, CLI_CLIENT_ID]),
    csp: authCsp([consoleOrigin]),
    consentApi,
    dataPlaneUrl: cfg.dataPlaneUrl,
  }))
  provider.use(devicePrefillMiddleware())
  provider.use(switchAccountMiddleware())
  return provider
}
