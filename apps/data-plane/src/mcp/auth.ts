import { MCP_SCOPE, mcpResource, protectedResourceMetadataUrl } from '@metamodels/schema'
import {
  JWKS_COOLDOWN_MS, KeySetUnavailableError, TokenError, type AccessTokenVerifier,
} from '@metamodels/schema/access-token'
import type { ConfigStore } from '../config/config-store.js'
import type { ResolvedKey } from '../config/types.js'

export interface McpAuthDeps {
  /** `DATA_PLANE_URL`: the origin every MCP resource (and so every token's `aud`) is built on. */
  dataPlaneUrl: string
  verify: AccessTokenVerifier
}

/**
 * The challenge on every MCP 401: the scheme, where to discover the authorization server (RFC 9728
 * §5.1), and the scope to ask for (MCP 2026-07-28 authorization, "Scope Selection Strategy": servers
 * SHOULD include `scope`, and clients use it first). Nothing else: an `error=` parameter would grade
 * the refusals the fixed 401 body refuses to grade.
 */
export function mcpChallenge(slug: string, dataPlaneUrl: string): string {
  return `Bearer resource_metadata="${protectedResourceMetadataUrl(mcpResource(dataPlaneUrl, slug))}", scope="${MCP_SCOPE}"`
}

const MISSING = 'missing access token'
/** One body for every refused token, whatever the reason — as `unauthorized.ts` does for keys. */
const INVALID = 'invalid access token'

// A second copy of the control plane's cooldown-miss log policy
// (apps/control-plane/src/server/problem.ts logKeySetUnavailable): a fetch failure is logged every
// time; a cooldown miss, which anyone can cause with an unknown `kid`, at most once per cooldown.
let cooldownMissLoggedAt: number | undefined

function logKeySetUnavailable(e: KeySetUnavailableError): void {
  if (e.cooldownMiss) {
    const now = Date.now()
    if (cooldownMissLoggedAt !== undefined && now - cooldownMissLoggedAt < JWKS_COOLDOWN_MS) return
    cooldownMissLoggedAt = now
  }
  console.error(`[auth] 503 on /mcp, key set unavailable: ${e.reason}`)
}

function unauthorized(slug: string, dataPlaneUrl: string, body: string): Response {
  return new Response(JSON.stringify({ error: body }), {
    status: 401,
    headers: { 'content-type': 'application/json', 'www-authenticate': mcpChallenge(slug, dataPlaneUrl) },
  })
}

type Refused = { ok: false; res: Response }

/**
 * Spec M4 §4.2, steps 1–3: the bearer token must be an OP access token for exactly this paddock's MCP
 * resource, naming an active oauth key scoped to this paddock and approved for the token's client.
 * Step 4 (the paddock gates) is the shared pipeline's. `mm_live_` keys never get past step 2: they are
 * not JWTs, and `resolveKeyById` would not answer a live key if one were.
 */
export async function authenticateMcp(
  authorization: string | undefined,
  slug: string,
  deps: McpAuthDeps,
  store: ConfigStore,
): Promise<{ ok: true; key: ResolvedKey } | Refused> {
  const refuse = (reason: string): Refused => {
    // The reason goes to the operator's log only; the caller gets INVALID whatever it is.
    console.warn(`[auth] 401 on /mcp: ${reason}`)
    return { ok: false, res: unauthorized(slug, deps.dataPlaneUrl, INVALID) }
  }

  const token = authorization ? /^Bearer +(.+)$/i.exec(authorization)?.[1]?.trim() : undefined
  if (!token) return { ok: false, res: unauthorized(slug, deps.dataPlaneUrl, MISSING) }
  if (token.startsWith('mm_live_')) return refuse('an API key was presented; MCP takes OAuth access tokens only')

  let claims: Record<string, unknown>
  try {
    claims = await deps.verify(token, mcpResource(deps.dataPlaneUrl, slug))
  } catch (e) {
    if (e instanceof KeySetUnavailableError) {
      logKeySetUnavailable(e)
      return {
        ok: false,
        res: new Response(JSON.stringify({ error: 'access token keys unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json', 'retry-after': String(JWKS_COOLDOWN_MS / 1000) },
        }),
      }
    }
    if (e instanceof TokenError) return refuse(e.reason)
    throw e
  }

  const scopes = typeof claims.scope === 'string' ? claims.scope.split(' ') : []
  if (!scopes.includes(MCP_SCOPE)) return refuse('the token does not carry the mcp scope')
  if (typeof claims.mm_kid !== 'string') return refuse('the token names no key')
  const key = await store.resolveKeyById(claims.mm_kid)
  if (!key) return refuse('the token names no active oauth key')
  // Not redundant with the store's own filter (ruling F9): a cached key can outlive its expires_at by the cache TTL.
  if (key.expiresAt && key.expiresAt.getTime() < Date.now()) return refuse('the oauth key has expired')
  if (!key.paddockSlugs.includes(slug)) return refuse('the oauth key is not scoped to this paddock')
  if (claims.client_id !== key.oauthClientId) return refuse('the token client is not the client the key was approved for')
  return { ok: true, key }
}
