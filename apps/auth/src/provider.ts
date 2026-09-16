import Provider, { type ClientMetadata, type Configuration } from 'oidc-provider'
import { CONSOLE_CLIENT_ID } from '@metamodels/schema'
import { makeFindAccount } from './account.js'
import { pgAdapterFactory } from './adapter.js'
import type { AuthConfig } from './config.js'
import type { Db } from './db.js'
import { interactionMiddleware } from './interactions.js'
import { signingJwks } from './keys.js'
import { LoginThrottle } from './login-throttle.js'
import { makeGetResourceServerInfo, resourceServers } from './resources.js'
import { authCsp, renderLogoutPage, renderMessagePage } from './views.js'

export interface ProviderOptions {
  /** More statically registered clients. Never auto-consented: M1 refuses them at the consent prompt. */
  extraClients?: readonly ClientMetadata[]
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

export function createProvider(cfg: AuthConfig, db: Db, opts: ProviderOptions = {}): Provider {
  const configuration: Configuration = {
    adapter: pgAdapterFactory(db),
    clients: [consoleClient(cfg), ...(opts.extraClients ?? [])],
    cookies: { keys: cfg.cookieKeys },
    jwks: signingJwks(cfg.signingKeyPem, cfg.allowEphemeralKey),
    findAccount: makeFindAccount(db),
    // OAuth 2.1: PKCE for every client, confidential ones included.
    pkce: { required: () => true },
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    features: {
      devInteractions: { enabled: false },
      resourceIndicators: {
        enabled: true,
        getResourceServerInfo: makeGetResourceServerInfo(resourceServers(cfg.consoleUrl)),
        // Clients must name the resource at the token endpoint as well; an openid-only exchange
        // returns an opaque userinfo token, never a resource-bound JWT.
        useGrantedResource: async () => false,
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
    renderError: (ctx, out) => {
      ctx.type = 'html'
      ctx.body = renderMessagePage('Sign-in error', out.error_description ?? out.error)
    },
    ttl: {
      AccessToken: 60 * 60,
      AuthorizationCode: 60,
      IdToken: 60 * 60,
      Interaction: 10 * 60,
      Session: 14 * 24 * 60 * 60,
      Grant: 14 * 24 * 60 * 60,
    },
  }

  const provider = new Provider(cfg.issuer, configuration)
  // Deployed behind a TLS-terminating proxy or tunnel: trust X-Forwarded-Proto/For so issued URLs
  // and cookie `secure` flags are right (oidc-provider docs, "Trusting TLS offloading proxies").
  provider.proxy = true
  provider.use(interactionMiddleware({
    provider,
    db,
    throttle: new LoginThrottle(),
    firstPartyClientIds: new Set([CONSOLE_CLIENT_ID]),
    csp: authCsp([new URL(cfg.consoleUrl).origin]),
  }))
  return provider
}
