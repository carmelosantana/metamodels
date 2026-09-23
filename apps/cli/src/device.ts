import { CLI_CLIENT_ID, type Capability } from '@metamodels/schema'
import { requireSecureTransport } from './config.js'
import type { StoredCredential } from './credentials.js'

/**
 * The CLI's side of the OP: discovery, the RFC 8628 device grant, refresh, and RFC 7009 revocation.
 * Global `fetch`, no dependencies.
 *
 * No function here puts a token in a message it throws or prints. OAuth error bodies are echoed
 * (`error`, `error_description`): the OP writes those, and they name what went wrong, not a token.
 */

export interface OpDeps {
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Where operator-facing lines go (stderr in the CLI). */
  print?: (line: string) => void
  /** Accept plain-http OP endpoints on hosts that are not loopback (`--allow-insecure-http`). */
  allowInsecureHttp?: boolean
}

/**
 * Every OP request is bounded. The refresh runs under the credentials lock, and a holder must let
 * go well inside `LOCK_STALE_MS` (60s) or a waiter takes the lock over: discovery plus the token
 * request at 15s each stays inside it.
 */
const REQUEST_TIMEOUT_MS = 15_000

const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

/** The confirm page shows the requesting machine's user agent; this is what it will say. */
const USER_AGENT = `metamodels-cli (${process.platform}; ${process.arch})`

/** A refresh the OP refused. The token it presented is spent: the only way on is `mm login`. */
export class SignInAgainError extends Error {
  constructor(why: string) {
    super(`${why}; run \`mm login\` to sign in again`)
    this.name = 'SignInAgainError'
  }
}

export interface OpMetadata {
  tokenEndpoint: string
  deviceAuthorizationEndpoint: string
  revocationEndpoint?: string
}

function deps(d: OpDeps) {
  return {
    fetch: d.fetch ?? globalThis.fetch,
    sleep: d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    now: d.now ?? Date.now,
    print: d.print ?? ((line: string) => { process.stderr.write(`${line}\n`) }),
  }
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const body = await res.json()
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * Every OP request refuses redirects. `fetch` would otherwise follow a 307 or 308 with the same
 * method and body, carrying a refresh token or device code to wherever the `Location` points.
 */
function refuseRedirect(res: Response, what: string): void {
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`${what} answered with a redirect (HTTP ${res.status}); refusing to follow it`)
  }
}

async function postForm(d: ReturnType<typeof deps>, url: string, fields: Record<string, string>) {
  const res = await d.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': USER_AGENT },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  refuseRedirect(res, 'the authorization server')
  return { status: res.status, json: await readJson(res) }
}

/** "invalid_grant: grant request is invalid" — never the request that caused it. */
function oauthError(json: Record<string, unknown>, status: number): string {
  const error = typeof json.error === 'string' ? json.error : `HTTP ${status}`
  return typeof json.error_description === 'string' ? `${error}: ${json.error_description}` : error
}

/** The OP's metadata, refused unless it names exactly the issuer we asked (RFC 8414 §3.3). */
export async function discover(issuer: string, o: OpDeps = {}): Promise<OpMetadata> {
  const d = deps(o)
  const res = await d.fetch(`${issuer}/.well-known/openid-configuration`, {
    headers: { accept: 'application/json', 'user-agent': USER_AGENT },
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  refuseRedirect(res, `discovery at ${issuer}`)
  if (!res.ok) throw new Error(`discovery at ${issuer} failed: HTTP ${res.status}`)
  const meta = await readJson(res)
  if (meta.issuer !== issuer) {
    throw new Error(`discovery at ${issuer} names a different issuer (${String(meta.issuer)}); refusing it`)
  }
  if (typeof meta.token_endpoint !== 'string' || typeof meta.device_authorization_endpoint !== 'string') {
    throw new Error(`${issuer} does not offer the device authorization grant`)
  }
  // Each of these receives a credential (device code, refresh token), and the document can name any
  // URL: the issuer being https says nothing about them.
  const allow = o.allowInsecureHttp ?? false
  requireSecureTransport(meta.token_endpoint, `the OP's token_endpoint`, allow)
  requireSecureTransport(meta.device_authorization_endpoint, `the OP's device_authorization_endpoint`, allow)
  if (typeof meta.revocation_endpoint === 'string') {
    requireSecureTransport(meta.revocation_endpoint, `the OP's revocation_endpoint`, allow)
  }
  return {
    tokenEndpoint: meta.token_endpoint,
    deviceAuthorizationEndpoint: meta.device_authorization_endpoint,
    ...(typeof meta.revocation_endpoint === 'string' ? { revocationEndpoint: meta.revocation_endpoint } : {}),
  }
}

/**
 * RFC 6750 §2.1 `b64token`, the syntax of a Bearer credential. The access token goes into a header,
 * where a CR, LF or NUL makes `fetch` throw an error quoting the whole value, so a token outside
 * this set is refused here, before it is stored, and the refusal does not quote it. The refresh
 * token is held to the same set, which is stricter than RFC 6749's (any printable ASCII); this
 * OP's refresh tokens are base64url.
 */
const B64TOKEN = /^[A-Za-z0-9\-._~+/]+=*$/

/** A token-endpoint success as a credential. `previousRefresh` is kept only if no successor came back. */
function toCredential(
  issuer: string, resource: string, json: Record<string, unknown>, now: number, previousRefresh?: string,
): StoredCredential {
  if (typeof json.access_token !== 'string' || typeof json.expires_in !== 'number') {
    throw new Error('the token endpoint answered without an access token')
  }
  if (!B64TOKEN.test(json.access_token)) throw new Error('the token endpoint answered with a malformed access token')
  if (json.refresh_token !== undefined && (typeof json.refresh_token !== 'string' || !B64TOKEN.test(json.refresh_token))) {
    throw new Error('the token endpoint answered with a malformed refresh token')
  }
  // A rotating OP (ours) always returns a successor, and the presented token is then spent: store
  // the new one. RFC 6749 §6 keeps the old one only when no new one is issued.
  const refreshToken = typeof json.refresh_token === 'string' ? json.refresh_token : previousRefresh
  return {
    issuer,
    resource,
    scope: typeof json.scope === 'string' ? json.scope : '',
    accessToken: json.access_token,
    accessExpiresAt: now + json.expires_in * 1000,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    obtainedAt: now,
  }
}

/**
 * RFC 8628: start a device authorization for the admin-API resource, tell the operator where to
 * approve it, and poll until they do, refuse, or the code expires.
 *
 * `resource` is named on the device request AND on every poll: the OP does not fall back to the
 * granted resource, so a token request without it returns an opaque userinfo token instead of a
 * resource-bound JWT.
 */
export async function deviceLogin(
  o: { issuer: string; resource: string; scopes: readonly Capability[] }, od: OpDeps = {},
): Promise<StoredCredential> {
  const d = deps(od)
  const meta = await discover(o.issuer, od)
  const start = await postForm(d, meta.deviceAuthorizationEndpoint, {
    client_id: CLI_CLIENT_ID,
    scope: ['openid', 'offline_access', ...o.scopes].join(' '),
    resource: o.resource,
  })
  if (start.status !== 200) throw new Error(`the sign-in could not start: ${oauthError(start.json, start.status)}`)
  const { device_code: deviceCode, user_code: userCode, verification_uri: uri } = start.json
  const complete = start.json.verification_uri_complete
  const expiresIn = start.json.expires_in
  if (typeof deviceCode !== 'string' || typeof userCode !== 'string' || typeof uri !== 'string' || typeof expiresIn !== 'number') {
    throw new Error('the sign-in could not start: the device authorization response is incomplete')
  }

  if (typeof complete === 'string') {
    d.print('To sign in, open this page in a browser:')
    d.print('')
    d.print(`  ${complete}`)
    d.print('')
    d.print(`and check that it shows the code  ${userCode}`)
  } else {
    d.print(`To sign in, open ${uri} in a browser and enter the code  ${userCode}`)
  }
  d.print('')
  d.print('The page asks for your MetaModels password, even if you are already signed in, and shows')
  d.print('the IP address and user agent of the machine asking to sign in. If those are not this')
  d.print("machine's, press Cancel: someone else is trying to sign in as you.")
  d.print('')
  d.print('Waiting for approval...')

  // RFC 8628 §3.2: five seconds when the server names no interval.
  let interval = (typeof start.json.interval === 'number' ? start.json.interval : 5) * 1000
  const deadline = d.now() + expiresIn * 1000
  for (;;) {
    await d.sleep(interval)
    if (d.now() > deadline) throw new Error('the sign-in code expired before it was approved; run `mm login` again')
    const poll = await postForm(d, meta.tokenEndpoint, {
      grant_type: DEVICE_CODE_GRANT,
      device_code: deviceCode,
      client_id: CLI_CLIENT_ID,
      resource: o.resource,
    })
    if (poll.status === 200) return toCredential(o.issuer, o.resource, poll.json, d.now())
    switch (poll.json.error) {
      case 'authorization_pending':
        continue
      case 'slow_down':
        // RFC 8628 §3.5: add five seconds, for this and every later poll.
        interval += 5000
        continue
      case 'expired_token':
        throw new Error('the sign-in code expired before it was approved; run `mm login` again')
      case 'access_denied':
        throw new Error('the sign-in was cancelled in the browser')
      default:
        throw new Error(`the sign-in failed: ${oauthError(poll.json, poll.status)}`)
    }
  }
}

/**
 * One refresh-token grant, naming the same resource (without it the OP answers with an opaque
 * userinfo token). Throws `SignInAgainError` on any 4xx: the OP consumes the presented token before
 * it decides, so a refused refresh has already spent it, and presenting it again is a reuse that
 * revokes the whole grant. A 5xx or a network failure throws a plain error — the OP may never have
 * seen the token, so the caller keeps it.
 *
 * Unlocked. Callers use `refreshStored` (`session.ts`), which serialises refreshes across processes.
 */
export async function refresh(
  o: { issuer: string; resource: string; refreshToken: string }, od: OpDeps = {},
): Promise<StoredCredential> {
  const d = deps(od)
  const meta = await discover(o.issuer, od)
  const res = await postForm(d, meta.tokenEndpoint, {
    grant_type: 'refresh_token',
    refresh_token: o.refreshToken,
    client_id: CLI_CLIENT_ID,
    resource: o.resource,
  })
  if (res.status === 200) return toCredential(o.issuer, o.resource, res.json, d.now(), o.refreshToken)
  if (res.status >= 400 && res.status < 500) {
    throw new SignInAgainError(`the sign-in could not be renewed (${oauthError(res.json, res.status)})`)
  }
  throw new Error(`the sign-in could not be renewed: the authorization server answered HTTP ${res.status}`)
}

/**
 * RFC 7009: revoke the refresh token (and with it, at our OP, the grant). True only on the 200 the
 * RFC defines; false — never a throw — when the OP has no revocation endpoint, refuses, or cannot
 * be reached, so `mm logout` can still forget the token locally and say what happened.
 */
export async function revokeRefreshToken(o: { issuer: string; refreshToken: string }, od: OpDeps = {}): Promise<boolean> {
  const d = deps(od)
  try {
    const meta = await discover(o.issuer, od)
    if (meta.revocationEndpoint === undefined) return false
    const res = await postForm(d, meta.revocationEndpoint, {
      token: o.refreshToken,
      token_type_hint: 'refresh_token',
      client_id: CLI_CLIENT_ID,
    })
    return res.status === 200
  } catch {
    return false
  }
}
