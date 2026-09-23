export interface AuthConfig {
  /** Public issuer URL (origin only, no trailing slash). Browsers, clients and token `iss` all see this. */
  issuer: string
  /** Public console URL (origin only, no trailing slash). */
  consoleUrl: string
  consoleClientSecret: string
  /** Cookie-signing keys, newest first. */
  cookieKeys: string[]
  /** PKCS#8 PEM of the RSA signing key, or null when unset (only legal with allowEphemeralKey). */
  signingKeyPem: string | null
  /**
   * Verification-only keys, published AFTER the signer. Rotation without an overlap window
   * invalidates every in-flight access token at once (M1 handoff); this is the window.
   */
  previousSigningKeyPems: string[]
  allowEphemeralKey: boolean
  databaseUrl: string
  port: number
}

type Env = Record<string, string | undefined>

const MIN_SECRET_LENGTH = 16

function required(env: Env, name: string): string {
  const v = env[name]?.trim()
  if (!v) throw new Error(`${name} is required`)
  return v
}

/** An absolute http(s) URL that is a bare origin; returned without a trailing slash. */
function origin(name: string, value: string): string {
  let u: URL
  try {
    u = new URL(value)
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`${name} must be an absolute http(s) URL`)
  if (u.pathname !== '/' || u.search || u.hash) throw new Error(`${name} must be an origin (no path, query or fragment)`)
  return u.origin
}

/**
 * Base64 → PKCS#8 PEM. Shared by OIDC_SIGNING_KEY and OIDC_PREVIOUS_SIGNING_KEYS so a previous
 * key can never be decoded or checked more loosely than the signer, and so a malformed one fails
 * the container at boot rather than at the first token exchange.
 */
function decodeKeyPem(name: string, b64: string): string {
  const pem = Buffer.from(b64, 'base64').toString('utf8')
  if (!pem.includes('-----BEGIN PRIVATE KEY-----')) {
    throw new Error(`${name} must be base64 of a PKCS#8 PEM (-----BEGIN PRIVATE KEY-----)`)
  }
  return pem
}

function secret(name: string, value: string): string {
  if (value.length < MIN_SECRET_LENGTH) throw new Error(`${name} must be at least ${MIN_SECRET_LENGTH} characters`)
  return value
}

export function loadAuthConfig(env: Env): AuthConfig {
  const cookieKeys = required(env, 'OIDC_COOKIE_KEYS').split(',').map((k) => k.trim()).filter(Boolean)
  for (const k of cookieKeys) secret('OIDC_COOKIE_KEYS', k)

  const allowEphemeralKey = env.OIDC_ALLOW_EPHEMERAL_KEY === 'true'
  const rawKey = env.OIDC_SIGNING_KEY?.trim()
  let signingKeyPem: string | null = null
  if (rawKey) {
    signingKeyPem = decodeKeyPem('OIDC_SIGNING_KEY', rawKey)
  } else if (!allowEphemeralKey) {
    throw new Error('OIDC_SIGNING_KEY is required (OIDC_ALLOW_EPHEMERAL_KEY=true is for local development only)')
  }

  const previousSigningKeyPems = (env.OIDC_PREVIOUS_SIGNING_KEYS ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => decodeKeyPem('OIDC_PREVIOUS_SIGNING_KEYS', k))

  const port = env.AUTH_PORT ? Number(env.AUTH_PORT) : 3100
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('AUTH_PORT must be a TCP port number')

  return {
    issuer: origin('OIDC_ISSUER', required(env, 'OIDC_ISSUER')),
    consoleUrl: origin('CONSOLE_URL', required(env, 'CONSOLE_URL')),
    consoleClientSecret: secret('CONSOLE_CLIENT_SECRET', required(env, 'CONSOLE_CLIENT_SECRET')),
    cookieKeys,
    signingKeyPem,
    previousSigningKeyPems,
    allowEphemeralKey,
    databaseUrl: required(env, 'DATABASE_URL'),
    port,
  }
}
