import { errors, type Client, type ResourceServer } from 'oidc-provider'
import { adminApiResource, CAPABILITIES, CLI_CLIENT_ID, CONSOLE_CLIENT_ID } from '@metamodels/schema'

/**
 * Every resource server this OP issues access tokens for. Tokens are RFC 9068 JWTs so resource
 * servers verify them offline against /jwks. This map IS the token contract M2 and M4 consume;
 * M4 adds one entry per published paddock.
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
 * is listed here. The CLI exists to reach the admin API; the console keeps the admin-API access it
 * has had since M1, though the admin API itself accepts no console session (spec §3.2).
 */
export function resourcesByClient(consoleUrl: string): ReadonlyMap<string, ReadonlySet<string>> {
  const admin = adminApiResource(consoleUrl)
  return new Map([
    [CONSOLE_CLIENT_ID, new Set([admin])],
    [CLI_CLIENT_ID, new Set([admin])],
  ])
}

/**
 * oidc-provider's `getResourceServerInfo` — the per-client resource gate. oidc-provider consults it
 * for every resource a request names, at the authorization, device-authorization and token
 * endpoints and on every refresh, passing the requesting client as the third argument. Two checks,
 * both `invalid_target`: the resource must be declared in `servers`, AND the client must be listed
 * in `allowedByClient` with that resource in its set. An unlisted client is refused every resource; it
 * never falls through to allowed.
 */
export function makeGetResourceServerInfo(
  servers: ReadonlyMap<string, ResourceServer>,
  allowedByClient: ReadonlyMap<string, ReadonlySet<string>>,
) {
  return async (
    _ctx: unknown,
    resourceIndicator: string,
    client: Pick<Client, 'clientId'>,
  ): Promise<ResourceServer> => {
    const rs = servers.get(resourceIndicator)
    if (!rs) throw new errors.InvalidTarget()
    if (!allowedByClient.get(client.clientId)?.has(resourceIndicator)) throw new errors.InvalidTarget()
    return rs
  }
}
