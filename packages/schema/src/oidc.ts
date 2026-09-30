import { PADDOCK_SLUG_MAX, PADDOCK_SLUG_RE } from './enums.js'

/**
 * Identifiers the auth service (the issuer) and the console (a client, and from M2 the admin
 * API's resource server) must agree on byte for byte. One definition, imported by both.
 */

/** The console's OAuth client_id — the `aud` of every console ID token. */
export const CONSOLE_CLIENT_ID = 'metamodels-console'

/** The admin CLI's OAuth client_id — the `client_id` claim of every access token the CLI holds. */
export const CLI_CLIENT_ID = 'metamodels-cli'

/** The admin API's RFC 8707 resource indicator — and therefore the `aud` of its access tokens. */
export function adminApiResource(consoleUrl: string): string {
  return `${consoleUrl}/api/admin`
}

/**
 * How long an operator stays signed in: the console's `mm_session` lifetime AND the auth
 * service's OP session lifetime. They must match — an OP session that outlives the console
 * session would silently sign the browser back in, with no password, after the console session
 * ends.
 */
export const OPERATOR_SESSION_TTL_MS = 12 * 60 * 60 * 1000

/** The one scope an MCP resource declares (M4 D2). */
export const MCP_SCOPE = 'mcp'

/**
 * The `typ` of the OP-signed assertion the auth service sends to the control plane's internal
 * oauth-keys route (M4 D7). Distinct from `at+jwt`, so an access token can never be replayed as an
 * assertion, nor an assertion as an access token.
 */
export const CONSENT_ASSERTION_TYP = 'mm-consent+jwt'

/**
 * A paddock's MCP resource indicator (RFC 8707), and therefore the `aud` of every MCP access token
 * for it. MCP clients send the URL they connect to as `resource`, so this IS the endpoint URL.
 * `dataPlaneUrl` is `DATA_PLANE_URL`: a bare origin, configured, never derived.
 */
export function mcpResource(dataPlaneUrl: string, slug: string): string {
  return `${dataPlaneUrl}/p/${slug}/mcp`
}

/**
 * The paddock slug an MCP resource indicator names, or null when `uri` is not exactly
 * `mcpResource(dataPlaneUrl, <a slug a paddock could have>)`. No normalisation: a trailing slash, a
 * query, another scheme or another host are all a different resource, and none is ours.
 */
export function parseMcpResource(dataPlaneUrl: string, uri: string): string | null {
  const prefix = `${dataPlaneUrl}/p/`
  const suffix = '/mcp'
  if (!uri.startsWith(prefix) || !uri.endsWith(suffix)) return null
  const slug = uri.slice(prefix.length, uri.length - suffix.length)
  return slug.length <= PADDOCK_SLUG_MAX && PADDOCK_SLUG_RE.test(slug) ? slug : null
}

/** The `aud` of the OP's consent assertion: the control plane's internal API (M4 D7). */
export function internalApiAudience(consoleUrl: string): string {
  return `${consoleUrl}/api/internal`
}

/**
 * RFC 9728 §3.1: a resource's metadata lives at its origin, with `/.well-known/oauth-protected-resource`
 * inserted before the resource's path. Both resource servers advertise it in their 401 challenges.
 */
export function protectedResourceMetadataUrl(resource: string): string {
  const u = new URL(resource)
  return `${u.origin}/.well-known/oauth-protected-resource${u.pathname === '/' ? '' : u.pathname}`
}

/**
 * An environment variable that must hold an absolute http(s) URL with no path, query or fragment;
 * returned as `URL.origin` (no trailing slash). The same rules as the auth service's `OIDC_ISSUER`
 * and `CONSOLE_URL`, for the settings M4 adds (`DATA_PLANE_URL`, `CONTROL_PLANE_INTERNAL_URL`).
 */
export function requireOrigin(name: string, value: string | undefined): string {
  const v = value?.trim()
  if (!v) throw new Error(`${name} is required`)
  let u: URL
  try {
    u = new URL(v)
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`${name} must be an absolute http(s) URL`)
  if (u.pathname !== '/' || u.search || u.hash) throw new Error(`${name} must be an origin (no path, query or fragment)`)
  return u.origin
}

/**
 * An RFC 9728 protected-resource metadata document. Both resource servers build theirs here, from the
 * same resource helpers as the OP's resource map, so the issuer, resource and scopes cannot drift.
 */
export function protectedResourceMetadata(resource: string, issuer: string, scopes: readonly string[]) {
  return {
    resource,
    authorization_servers: [issuer],
    scopes_supported: [...scopes],
    bearer_methods_supported: ['header'],
  }
}
