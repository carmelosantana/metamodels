import { errors, type ResourceServer } from 'oidc-provider'
import { adminApiResource, CAPABILITIES } from '@metamodels/schema'

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

/** oidc-provider's `getResourceServerInfo`: known resources only, everything else `invalid_target`. */
export function makeGetResourceServerInfo(servers: ReadonlyMap<string, ResourceServer>) {
  return async (_ctx: unknown, resourceIndicator: string): Promise<ResourceServer> => {
    const rs = servers.get(resourceIndicator)
    if (!rs) throw new errors.InvalidTarget()
    return rs
  }
}
