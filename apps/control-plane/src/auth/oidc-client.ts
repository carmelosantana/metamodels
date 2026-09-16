import { createHash, randomBytes } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { CONSOLE_CLIENT_ID } from '@metamodels/schema'

const METADATA_TTL_MS = 5 * 60 * 1000
const TIMEOUT_MS = 10_000

export interface OidcClientConfig {
  /** Public issuer: where browsers are sent, and what `iss` must equal. */
  issuer: string
  /** Where this server reaches the OP. Equals `issuer` unless the OP is on a private network hop. */
  internalUrl: string
  /** Public console origin. Redirect and post-logout URIs derive from it. */
  consoleUrl: string
  clientSecret: string
}

export interface AuthTransaction {
  state: string
  nonce: string
  codeVerifier: string
}

export interface OidcMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  end_session_endpoint: string
}

export class OidcError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OidcError'
  }
}

type Env = Record<string, string | undefined>

function originOf(name: string, value: string | undefined): string {
  if (!value?.trim()) throw new OidcError(`${name} is required`)
  let u: URL
  try {
    u = new URL(value)
  } catch {
    throw new OidcError(`${name} must be an absolute http(s) URL`)
  }
  if (u.pathname !== '/' || u.search || u.hash) throw new OidcError(`${name} must be an origin (no path, query or fragment)`)
  return u.origin
}

export function loadOidcClientConfig(env: Env = {
  OIDC_ISSUER: process.env.OIDC_ISSUER,
  OIDC_INTERNAL_URL: process.env.OIDC_INTERNAL_URL,
  CONSOLE_URL: process.env.CONSOLE_URL,
  CONSOLE_CLIENT_SECRET: process.env.CONSOLE_CLIENT_SECRET,
}): OidcClientConfig {
  const issuer = originOf('OIDC_ISSUER', env.OIDC_ISSUER)
  const clientSecret = env.CONSOLE_CLIENT_SECRET ?? ''
  if (clientSecret.length < 16) throw new OidcError('CONSOLE_CLIENT_SECRET must be set (>=16 chars)')
  return {
    issuer,
    internalUrl: env.OIDC_INTERNAL_URL?.trim() ? originOf('OIDC_INTERNAL_URL', env.OIDC_INTERNAL_URL) : issuer,
    consoleUrl: originOf('CONSOLE_URL', env.CONSOLE_URL),
    clientSecret,
  }
}

export function newTransaction(): AuthTransaction {
  const random = () => randomBytes(32).toString('base64url')
  return { state: random(), nonce: random(), codeVerifier: random() }
}

/**
 * The sealed transaction payload as a usable AuthTransaction, or null if any field is unusable.
 *
 * `openJson` hands back `Record<string, unknown>`, so every field is validated rather than cast:
 * a cast would let a cookie missing `nonce` reach `exchangeCode` as `undefined`, where a bare
 * comparison against an ID token that also omits the claim would have quietly matched. Empty
 * strings are refused for the same reason — `exchangeCode` rejects `nonce === ''` outright.
 */
export function parseTransaction(p: Record<string, unknown> | null): AuthTransaction | null {
  if (!p) return null
  const usable = (v: unknown): v is string => typeof v === 'string' && v !== ''
  const { state, nonce, codeVerifier } = p
  if (!usable(state) || !usable(nonce) || !usable(codeVerifier)) return null
  return { state, nonce, codeVerifier }
}

export function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

/** The same URL on another origin — path and query kept, scheme and host replaced. */
export function onOrigin(url: string, origin: string): string {
  const u = new URL(url)
  const target = new URL(origin)
  u.protocol = target.protocol
  u.host = target.host
  return u.href
}

export class OidcClient {
  private meta?: { value: OidcMetadata; fetchedAt: number }
  private jwks?: JWTVerifyGetKey

  constructor(readonly cfg: OidcClientConfig, private readonly now: () => number = Date.now) {}

  get redirectUri(): string {
    return `${this.cfg.consoleUrl}/auth/callback`
  }

  get postLogoutRedirectUri(): string {
    return `${this.cfg.consoleUrl}/login`
  }

  async metadata(): Promise<OidcMetadata> {
    if (this.meta && this.now() - this.meta.fetchedAt < METADATA_TTL_MS) return this.meta.value
    const res = await fetch(`${this.cfg.internalUrl}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw new OidcError(`discovery failed: HTTP ${res.status}`)
    const m = (await res.json()) as Partial<OidcMetadata>
    if (m.issuer !== this.cfg.issuer) throw new OidcError(`issuer mismatch: expected ${this.cfg.issuer}, got ${String(m.issuer)}`)
    for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'end_session_endpoint'] as const) {
      if (typeof m[key] !== 'string') throw new OidcError(`discovery document lacks ${key}`)
    }
    // oidc-provider builds endpoint URLs from the request's own host (OIDCContext#urlFor resolves
    // against ctx.href), so a document fetched over the back channel names the internal host.
    // Re-home every endpoint explicitly: browser-facing ones onto the public issuer here,
    // server-to-server ones onto the back channel where they are called.
    const doc = m as OidcMetadata
    const value: OidcMetadata = {
      ...doc,
      authorization_endpoint: onOrigin(doc.authorization_endpoint, this.cfg.issuer),
      end_session_endpoint: onOrigin(doc.end_session_endpoint, this.cfg.issuer),
    }
    this.meta = { value, fetchedAt: this.now() }
    return this.meta.value
  }

  async authorizationUrl(tx: AuthTransaction, loginHint?: string): Promise<string> {
    const url = new URL((await this.metadata()).authorization_endpoint)
    url.search = new URLSearchParams({
      client_id: CONSOLE_CLIENT_ID,
      response_type: 'code',
      scope: 'openid',
      redirect_uri: this.redirectUri,
      state: tx.state,
      nonce: tx.nonce,
      code_challenge: codeChallenge(tx.codeVerifier),
      code_challenge_method: 'S256',
      // A hint alone never makes the OP prompt (oidc-provider's login prompt checks only for a
      // missing session, max_age, id_token_hint and claims), so a browser with an existing OP
      // session would be signed in as that other user. A hinted sign-in is always a fresh login.
      ...(loginHint ? { login_hint: loginHint, prompt: 'login' } : {}),
    }).toString()
    return url.href
  }

  /** Back-channel code exchange, then ID-token verification. Returns the subject (the user id). */
  async exchangeCode(code: string, tx: AuthTransaction): Promise<{ sub: string }> {
    const meta = await this.metadata()
    const basic = Buffer.from(`${encodeURIComponent(CONSOLE_CLIENT_ID)}:${encodeURIComponent(this.cfg.clientSecret)}`).toString('base64')
    const res = await fetch(onOrigin(meta.token_endpoint, this.cfg.internalUrl), {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: this.redirectUri, code_verifier: tx.codeVerifier,
      }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const json = (await res.json().catch(() => ({}))) as { id_token?: unknown; error?: unknown }
    if (!res.ok || typeof json.id_token !== 'string') {
      throw new OidcError(`token exchange failed: ${String(json.error ?? `HTTP ${res.status}`)}`)
    }

    this.jwks ??= createRemoteJWKSet(new URL(onOrigin(meta.jwks_uri, this.cfg.internalUrl)))
    const { payload } = await jwtVerify(json.id_token, this.jwks, {
      issuer: this.cfg.issuer, audience: CONSOLE_CLIENT_ID, algorithms: ['RS256'],
    })
    // Validate the expected nonce, never just compare it. A transaction reconstituted from a sealed
    // cookie arrives as `Record<string, unknown>`; if a caller casts instead of validating, a cookie
    // missing `nonce` gives `tx.nonce === undefined`, an ID token without the claim gives
    // `payload.nonce === undefined`, and a bare `!==` would quietly accept the pair.
    if (typeof tx.nonce !== 'string' || tx.nonce === '' || payload.nonce !== tx.nonce) {
      throw new OidcError('ID token nonce mismatch')
    }
    if (typeof payload.sub !== 'string' || payload.sub === '') throw new OidcError('ID token has no subject')
    return { sub: payload.sub }
  }

  async endSessionUrl(): Promise<string> {
    const url = new URL((await this.metadata()).end_session_endpoint)
    url.search = new URLSearchParams({ client_id: CONSOLE_CLIENT_ID, post_logout_redirect_uri: this.postLogoutRedirectUri }).toString()
    return url.href
  }
}
