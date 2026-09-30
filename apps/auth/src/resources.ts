import { errors, type Client, type ResourceServer } from 'oidc-provider'
import { adminApiResource, CAPABILITIES, CLI_CLIENT_ID, MCP_SCOPE, parseMcpResource } from '@metamodels/schema'
import { isCimdClient } from './cimd.js'
import type { Db } from './db.js'
import { activeOauthKeyForGrant } from './paddocks.js'

/**
 * Every resource server this OP issues access tokens for. Tokens are RFC 9068 JWTs so resource
 * servers verify them offline against /jwks. This map IS the token contract M2 and M4 consume.
 * MCP resources are not in this map: they are resolved per paddock by `makeGetResourceServerInfo`.
 */
export function resourceServers(consoleUrl: string): ReadonlyMap<string, ResourceServer> {
  return new Map([[adminApiResource(consoleUrl), {
    scope: CAPABILITIES.join(' '),
    accessTokenFormat: 'jwt',
    accessTokenTTL: 60 * 60,
    jwt: { sign: { alg: 'RS256' } },
  }]])
}

/**
 * oidc-provider's `ttl.AccessToken`. It consults a token's resource server ONLY when this option is
 * a function: `BaseToken.expiresIn` returns a numeric `ttl.AccessToken` as-is and never looks at the
 * token, which would make every `accessTokenTTL` above dead config — M4's per-paddock lifetimes
 * included. Tokens bound to no resource server (the opaque userinfo ones) keep the one-hour default.
 */
export function accessTokenTtl(
  _ctx: unknown,
  token: { resourceServer?: { accessTokenTTL?: number } },
): number {
  return token.resourceServer?.accessTokenTTL ?? 60 * 60
}

/**
 * Which resources each statically registered client may ask for. A client absent from this map
 * may ask for none — including every `extraClients` entry and any client M4 admits later until it
 * is listed here. Only the CLI may reach the admin API, and only through the device flow, which asks
 * for the password every time (spec A4). The console is deliberately absent (spec A15): it signs
 * operators in with `openid` alone, and its authorization-code flow auto-consents on a live OP
 * session, so an admin-API token for it would need no fresh password. The admin API refuses any
 * other client's token too (`verifyAdminToken`), so listing a client here is not enough on its own.
 */
export function resourcesByClient(consoleUrl: string): ReadonlyMap<string, ReadonlySet<string>> {
  return new Map([[CLI_CLIENT_ID, new Set([adminApiResource(consoleUrl)])]])
}

/** MCP access tokens live 15 minutes: the data plane verifies offline, and a revoked key is otherwise caught only by its config check (spec §3.2). */
export const MCP_ACCESS_TOKEN_TTL = 15 * 60

export function mcpResourceServer(): ResourceServer {
  return { scope: MCP_SCOPE, accessTokenFormat: 'jwt', accessTokenTTL: MCP_ACCESS_TOKEN_TTL, jwt: { sign: { alg: 'RS256' } } }
}

export interface McpResources {
  /** `DATA_PLANE_URL`: MCP resources are `${dataPlaneUrl}/p/<slug>/mcp`. */
  dataPlaneUrl: string
  isActivePaddock(slug: string): Promise<boolean>
}

/**
 * oidc-provider's `getResourceServerInfo` — the per-client resource gate. oidc-provider consults it
 * for every resource a request names, at the authorization, device-authorization and token
 * endpoints and on every refresh, passing the requesting client as the third argument.
 *
 * An MCP resource (one per paddock, M4 D2) is resolved dynamically: it is open only to CIMD clients,
 * and only while its paddock is active — so disabling a paddock also stops its tokens refreshing.
 * Every other resource is the static map: it must be declared in `servers`, AND the client must be
 * listed in `allowedByClient` with that resource in its set. Everything else is `invalid_target`.
 */
export function makeGetResourceServerInfo(
  servers: ReadonlyMap<string, ResourceServer>,
  allowedByClient: ReadonlyMap<string, ReadonlySet<string>>,
  mcp?: McpResources,
) {
  return async (
    _ctx: unknown,
    resourceIndicator: string,
    client: Pick<Client, 'clientId'>,
  ): Promise<ResourceServer> => {
    const slug = mcp ? parseMcpResource(mcp.dataPlaneUrl, resourceIndicator) : null
    if (slug !== null) {
      if (!isCimdClient(client)) throw new errors.InvalidTarget()
      if (!(await mcp!.isActivePaddock(slug))) throw new errors.InvalidTarget()
      return mcpResourceServer()
    }
    const rs = servers.get(resourceIndicator)
    if (!rs) throw new errors.InvalidTarget()
    if (!allowedByClient.get(client.clientId)?.has(resourceIndicator)) throw new errors.InvalidTarget()
    return rs
  }
}

/**
 * oidc-provider's `extraTokenClaims`. For an MCP access token it adds `mm_kid`, the oauth key the data
 * plane meters and scopes the caller by. It runs every time such a token is issued, first issue and
 * every refresh alike, so a key revoked on the Keys page (or by a user losing their role) makes the
 * grant unable to mint another: `invalid_grant`, and the client must ask the user again. Asking again
 * shows the consent screen even in a browser whose session still holds the grant (the `mcp_key_missing`
 * check in `interactionPolicyWithFreshDeviceLogin`), and Approve mints a new key onto that grant.
 */
export function makeExtraTokenClaims(db: Db, dataPlaneUrl: string) {
  return async (_ctx: unknown, token: unknown): Promise<{ mm_kid: string } | undefined> => {
    const t = token as { grantId?: string; resourceServer?: { identifier(): string } }
    const resource = t.resourceServer?.identifier()
    const slug = resource === undefined ? null : parseMcpResource(dataPlaneUrl, resource)
    if (slug === null) return undefined
    if (!t.grantId) throw new errors.InvalidGrant('an MCP token must be issued under a grant')
    const keyId = await activeOauthKeyForGrant(db, t.grantId, slug)
    if (!keyId) throw new errors.InvalidGrant('the key behind this grant has been revoked')
    return { mm_kid: keyId }
  }
}

/** What oidc-provider hands `issueRefreshToken` / `expiresWithSession`: an authorization code (or device code). */
export interface RefreshSource {
  /** One resource indicator as a string, several as an array (`lib/helpers/process_response_types.js`). */
  resource?: string | string[]
  scopes: ReadonlySet<string>
}

export interface RefreshClient {
  grantTypeAllowed(type: string): boolean
}

/**
 * Refresh tokens for MCP clients (ruling R4). oidc-provider issues one only for `offline_access`, which
 * it drops unless the request says `prompt=consent`, and real MCP clients send neither. For a CIMD client
 * allowed the refresh_token grant whose code names an MCP resource, this issues one, and does not bind it
 * to the OP browser session (the approving user's 12-hour sign-in). Its life is M2's refresh policy, and
 * revoking the key ends it (`makeExtraTokenClaims`). Every other case is oidc-provider's default, verbatim
 * (`lib/helpers/defaults.js:301-310` in 9.12.2), so the console and the CLI are unchanged.
 */
export function mcpRefreshPolicy(dataPlaneUrl: string) {
  const namesMcp = (source: RefreshSource) => {
    const r = source.resource
    const list = r === undefined ? [] : Array.isArray(r) ? r : [r]
    return list.some((uri) => parseMcpResource(dataPlaneUrl, uri) !== null)
  }
  const isMcp = (client: unknown, source: RefreshSource) =>
    isCimdClient(client) && (client as RefreshClient).grantTypeAllowed('refresh_token') && namesMcp(source)

  return {
    async issueRefreshToken(_ctx: unknown, client: RefreshClient, source: RefreshSource): Promise<boolean> {
      if (isMcp(client, source)) return true
      return client.grantTypeAllowed('refresh_token') && source.scopes.has('offline_access')
    },
    async expiresWithSession(ctx: { oidc: { client?: unknown } }, source: RefreshSource): Promise<boolean> {
      if (isMcp(ctx.oidc.client, source)) return false
      return !source.scopes.has('offline_access')
    },
  }
}
