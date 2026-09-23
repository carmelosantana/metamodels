import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { createLocalJWKSet, type JSONWebKeySet } from 'jose'
import type { ClientMetadata } from 'oidc-provider'
import type { AuthConfig } from '../../src/config.js'
import { CONSOLE_CLIENT_ID } from '@metamodels/schema'
import { createProvider } from '../../src/provider.js'
import { makeDb, type TestDb } from './db.js'

export const CONSOLE_URL = 'http://console.test'
export const CONSOLE_SECRET = 'console-secret-0123456789'
export const REDIRECT_URI = `${CONSOLE_URL}/auth/callback`

export interface TestOp {
  issuer: string
  db: TestDb
  close(): Promise<void>
}

/** A real OP on an ephemeral port, backed by a fresh pglite database. */
export async function startTestOp(
  opts: { extraClients?: ClientMetadata[]; signingKeyPem?: string; previousSigningKeyPems?: string[] } = {},
): Promise<TestOp> {
  const db = await makeDb()
  let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => { res.statusCode = 503; res.end() }
  const server = createServer((req, res) => handler(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  // The issuer must be known before the provider exists, so the port is taken first.
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const cfg: AuthConfig = {
    issuer,
    consoleUrl: CONSOLE_URL,
    consoleClientSecret: CONSOLE_SECRET,
    cookieKeys: ['cookie-key-0123456789abcdef'],
    signingKeyPem: opts.signingKeyPem ?? null,
    previousSigningKeyPems: opts.previousSigningKeyPems ?? [],
    allowEphemeralKey: true,
    databaseUrl: 'unused-in-tests',
    port: 0,
  }
  handler = createProvider(cfg, db, { extraClients: opts.extraClients }).callback()
  return {
    issuer,
    db,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}

/** Just enough of a browser cookie store: ignores Path/Domain, honours deletion. */
export class CookieJar {
  private readonly cookies = new Map<string, string>()
  /** Every raw Set-Cookie line received, in order — for asserting on attributes. */
  readonly setCookieLines: string[] = []

  store(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      this.setCookieLines.push(line)
      const [pair, ...attrs] = line.split(';')
      const eq = pair.indexOf('=')
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      const expired = attrs.some((a) => /^\s*expires=Thu, 01 Jan 1970/i.test(a) || /^\s*max-age=0\s*$/i.test(a))
      if (expired || value === '') this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }
}

/** One request, redirects NOT followed, cookies sent and stored. */
export async function send(jar: CookieJar, url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  const cookie = jar.header()
  if (cookie) headers.set('cookie', cookie)
  const res = await fetch(url, { ...init, headers, redirect: 'manual' })
  jar.store(res)
  return res
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

export type AuthorizeOutcome =
  | { kind: 'redirect'; url: URL; verifier: string; jar: CookieJar }
  | { kind: 'page'; status: number; body: string; verifier: string; jar: CookieJar }

export interface AuthorizeOptions {
  email?: string
  password?: string
  clientId?: string
  redirectUri?: string
  scope?: string
  pkce?: boolean
  extra?: Record<string, string>
  headers?: Record<string, string>
  /** Reuse a browser that already holds cookies (e.g. an established OP session). */
  jar?: CookieJar
}

/**
 * Drive the browser half of the authorization-code flow. Submits the login form once (when
 * `email` is given) and follows redirects until the client's redirect_uri — or stops at the first
 * page that is not a login form it is about to submit.
 */
export async function authorize(op: TestOp, o: AuthorizeOptions = {}): Promise<AuthorizeOutcome> {
  const jar = o.jar ?? new CookieJar()
  const { verifier, challenge } = pkcePair()
  const redirectUri = o.redirectUri ?? REDIRECT_URI
  const url = new URL(`${op.issuer}/auth`)
  url.search = new URLSearchParams({
    client_id: o.clientId ?? CONSOLE_CLIENT_ID,
    response_type: 'code',
    scope: o.scope ?? 'openid',
    redirect_uri: redirectUri,
    state: 'state-123',
    nonce: 'nonce-456',
    ...(o.pkce === false ? {} : { code_challenge: challenge, code_challenge_method: 'S256' }),
    ...o.extra,
  }).toString()

  let res = await send(jar, url.href, { headers: o.headers })
  let submitted = false
  for (let hop = 0; hop < 12; hop++) {
    if (res.status >= 300 && res.status < 400) {
      const next = new URL(res.headers.get('location')!, op.issuer)
      if (next.href.startsWith(redirectUri)) return { kind: 'redirect', url: next, verifier, jar }
      res = await send(jar, next.href, { headers: o.headers })
      continue
    }
    const body = await res.text()
    const action = /<form method="post" action="([^"]+)">/.exec(body)?.[1]
    if (action && !submitted && o.email !== undefined) {
      submitted = true
      res = await send(jar, new URL(action, op.issuer).href, {
        method: 'POST',
        headers: { ...o.headers, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email: o.email, password: o.password ?? '' }).toString(),
      })
      continue
    }
    return { kind: 'page', status: res.status, body, verifier, jar }
  }
  throw new Error('authorize(): too many redirects')
}

/** The console's back-channel token request, with client_secret_basic authentication. */
export async function exchangeCode(
  op: TestOp, code: string, verifier: string, extra: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const basic = Buffer.from(`${encodeURIComponent(CONSOLE_CLIENT_ID)}:${encodeURIComponent(CONSOLE_SECRET)}`).toString('base64')
  const res = await fetch(`${op.issuer}/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: verifier, ...extra,
    }).toString(),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

export async function opJwks(op: TestOp) {
  return createLocalJWKSet((await (await fetch(`${op.issuer}/jwks`)).json()) as JSONWebKeySet)
}
