import type { Client, ClientMetadata, Configuration, KoaContextWithOIDC } from 'oidc-provider'
import { isValidClientIdUrl } from 'oidc-provider/lib/helpers/client_id_metadata_document.js'

/**
 * The Client ID Metadata Document draft this OP implements. oidc-provider refuses to construct when
 * the acknowledged draft is not the one it ships, so a minor release that moves the draft fails at
 * boot and in `test/cimd.test.ts`, never as a silent behaviour change (spec §8).
 */
export const CIMD_ACK = 'draft-02'

const ALLOWED_GRANT_TYPES: ReadonlySet<string> = new Set(['authorization_code', 'refresh_token'])

/** `localhost`, 127.0.0.0/8 and `[::1]`, as `URL.hostname` spells them. */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname)
}

export type CimdGate = { enabled: true } | { enabled: false; reason: string }

/**
 * CIMD only on an issuer a remote client can trust: https, or plain http on a loopback host for local
 * clients and e2e. Any other issuer boots with CIMD off (spec §3.4).
 */
export function cimdGateForIssuer(issuer: string): CimdGate {
  const u = new URL(issuer)
  if (u.protocol === 'https:') return { enabled: true }
  if (u.protocol === 'http:' && isLoopbackHost(u.hostname)) return { enabled: true }
  return { enabled: false, reason: `OIDC_ISSUER (${u.origin}) is neither https nor http on a loopback host` }
}

/** https, or http to a loopback host (a native app's RFC 8252 redirect); never a fragment. */
export function isAcceptableRedirectUri(uri: string): boolean {
  const u = URL.parse(uri)
  if (!u || u.hash) return false
  return u.protocol === 'https:' || (u.protocol === 'http:' && isLoopbackHost(u.hostname))
}

/**
 * `allowClient`: every CIMD client must be a public client (`none`), use only the authorization-code
 * and refresh grants, and name only acceptable redirect URIs. PKCE S256 is already required for every
 * client (`pkce.required`).
 */
export function cimdClientAllowed(
  client: { tokenEndpointAuthMethod?: string; grantTypes?: readonly string[]; redirectUris?: readonly string[] },
): boolean {
  if (client.tokenEndpointAuthMethod !== 'none') return false
  const grants = client.grantTypes ?? []
  if (grants.length === 0 || !grants.every((g) => ALLOWED_GRANT_TYPES.has(g))) return false
  const uris = client.redirectUris ?? []
  return uris.length > 0 && uris.every(isAcceptableRedirectUri)
}

/**
 * `features.clientIdMetadataDocument`. Admission is open (D4a): any client whose id passes the
 * library's own `isValidClientIdUrl` may be fetched, and the consent screen is the gate. An
 * allowlist, if one is ever wanted, is additive here.
 */
export function cimdFeature() {
  return {
    enabled: true as const,
    ack: CIMD_ACK,
    allowFetch: (_ctx: KoaContextWithOIDC, clientId: string) => isValidClientIdUrl(clientId),
    allowClient: (_ctx: KoaContextWithOIDC, client: Client) => cimdClientAllowed(client),
  }
}

/** oidc-provider marks a client built from a metadata document with a non-enumerable `clientIdMetadataDocument: true`. */
export function isCimdClient(client: unknown): boolean {
  return typeof client === 'object' && client !== null
    && (client as { clientIdMetadataDocument?: unknown }).clientIdMetadataDocument === true
}

/**
 * Whether oidc-provider's CIMD fetch will carry its SSRF guard. The library builds the guard from
 * undici's global dispatcher (`lib/helpers/fetch_request.js`, `getAgent`) and, when that is missing,
 * silently fetches with no guard. This is the same lookup, so the OP can refuse to start instead.
 */
export function ssrfGuardAvailable(): boolean {
  void Response // Touching a fetch global is what makes Node install undici's global dispatcher.
  const g = globalThis as unknown as Record<symbol, { constructor?: unknown } | undefined>
  const dispatcher = g[Symbol.for('undici.globalDispatcher.2')] ?? g[Symbol.for('undici.globalDispatcher.1')]
  return typeof dispatcher?.constructor === 'function' && dispatcher.constructor !== Object
}

/**
 * A `configuration.fetch` that answers the given client ids from memory and hands every other URL to
 * the real fetch — with the options oidc-provider passed, so the SSRF guard still applies to those.
 * For tests and the e2e OP only (Task 15); production leaves `fetch` unset.
 */
export function cimdFixtureFetch(documents: Readonly<Record<string, ClientMetadata>>): NonNullable<Configuration['fetch']> {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!Object.hasOwn(documents, url)) return fetch(input, init)
    return new Response(JSON.stringify(documents[url]), { status: 200, headers: { 'content-type': 'application/json' } })
  }
}
