import { STATUS_CODES } from 'node:http'
import type { StoredCredential } from './credentials.js'

/** Where the access token comes from, and how a refused one is replaced (`session.ts`). */
export interface ApiSession {
  current(): StoredCredential
  refresh(stale: StoredCredential): Promise<StoredCredential>
}

export interface ApiRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** Relative to `/api/admin/v1`, e.g. `/flocks/{id}` with the id filled in. */
  path: string
  query?: Record<string, string>
  body?: unknown
}

export interface ApiResponse {
  status: number
  body: unknown
  /** The `cursor` of the next page, from `Link: <…>; rel="next"` (RFC 8288), when there is one. */
  next?: string
}

/** A non-2xx answer from the admin API, rendered from its RFC 9457 problem document. */
export class ApiProblemError extends Error {
  readonly status: number
  readonly problem: unknown
  constructor(status: number, problem: unknown) {
    super(formatProblem(status, problem))
    this.name = 'ApiProblemError'
    this.status = status
    this.problem = problem
  }
}

/**
 * An RFC 9457 problem as terminal text: `status title: detail`, then the missing `capability`
 * (so a scope mistake reads as one, not as a bare 403) and any validation `errors`, one per line.
 * Only those members are printed; the API puts nothing token-derived in any of them.
 */
export function formatProblem(status: number, problem: unknown): string {
  const p = typeof problem === 'object' && problem !== null ? (problem as Record<string, unknown>) : {}
  const title = typeof p.title === 'string' ? p.title : (STATUS_CODES[status] ?? 'Error')
  const lines = [typeof p.detail === 'string' ? `${status} ${title}: ${p.detail}` : `${status} ${title}`]
  if (typeof p.capability === 'string') lines.push(`  capability: ${p.capability} (sign in again with it in --scope)`)
  if (Array.isArray(p.errors)) {
    for (const e of p.errors as Array<Record<string, unknown>>) {
      const path = typeof e?.path === 'string' && e.path !== '' ? e.path : '(body)'
      lines.push(`  ${path}: ${String(e?.message)}`)
    }
  }
  return lines.join('\n')
}

/** The next page's cursor. A relative target resolves against the request URL (RFC 8288 §3.1). */
function nextCursor(link: string | null, base: URL): string | undefined {
  if (link === null) return undefined
  for (const part of link.split(',')) {
    const m = /^\s*<([^>]*)>\s*;\s*rel="?next"?\s*$/.exec(part)
    if (m) return new URL(m[1], base).searchParams.get('cursor') ?? undefined
  }
  return undefined
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text()
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** `: ECONNREFUSED` for a `fetch failed` whose cause carries a system error code, else nothing. */
function networkCode(e: unknown): string {
  const code = e instanceof Error && e.cause instanceof Error ? (e.cause as NodeJS.ErrnoException).code : undefined
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? `: ${code}` : ''
}

/**
 * One admin-API call. Authenticates with `Authorization: Bearer` and nothing else — never a cookie:
 * the API answers a bearer that arrives with a session cookie with 400, and this client keeps no
 * cookie jar to send one from.
 *
 * On a 401 it asks the session for a fresh token once and retries once. A second 401 is surfaced
 * as the API's problem, not retried: a token refreshed a moment ago and still refused will not be
 * fixed by another refresh. Redirects are not followed — the admin API issues none, and following
 * one would carry the bearer somewhere it was not meant for.
 */
export async function callApi(
  consoleUrl: string, session: ApiSession, req: ApiRequest, fetchImpl: typeof fetch = fetch,
): Promise<ApiResponse> {
  const url = new URL(`${consoleUrl}/api/admin/v1${req.path}`)
  for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v)

  const send = async (cred: StoredCredential) => {
    const headers: Record<string, string> = { authorization: `Bearer ${cred.accessToken}`, accept: 'application/json' }
    if (req.body !== undefined) headers['content-type'] = 'application/json'
    try {
      return await fetchImpl(url, {
        method: req.method,
        headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        redirect: 'manual',
      })
    } catch (e) {
      // A header `fetch` refuses is quoted in the message it throws, and one of these headers holds
      // the access token. So none of the thrown text is passed on — only the system error code of a
      // network failure (ECONNREFUSED, ENOTFOUND…), which is never a header value.
      throw new Error(`could not send the request to ${url.origin}${networkCode(e)}`)
    }
  }

  const first = session.current()
  let res = await send(first)
  if (res.status === 401) {
    await res.body?.cancel()
    res = await send(await session.refresh(first))
  }
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`the admin API answered with a redirect (HTTP ${res.status}); check --console`)
  }
  const body = await readBody(res)
  if (!res.ok) throw new ApiProblemError(res.status, body)
  const next = nextCursor(res.headers.get('link'), url)
  return { status: res.status, body, ...(next === undefined ? {} : { next }) }
}
