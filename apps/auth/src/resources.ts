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

/** oidc-provider's `getResourceServerInfo`: known resources only, everything else `invalid_target`. */
export function makeGetResourceServerInfo(servers: ReadonlyMap<string, ResourceServer>) {
  return async (_ctx: unknown, resourceIndicator: string): Promise<ResourceServer> => {
    const rs = servers.get(resourceIndicator)
    if (!rs) throw new errors.InvalidTarget()
    return rs
  }
}
