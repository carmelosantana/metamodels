import { Hono } from 'hono'
import type { Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { RequestCtx } from '@metamodels/connectors'
import { hashApiKey } from '@metamodels/schema'
import type { ResolvedKey } from './config/types.js'
import { registerMcpRoutes, type McpDeps } from './mcp/endpoint.js'
import { createPipeline, type PipelineDeps, type Refusal } from './pipeline.js'
import { unauthorizedKey } from './unauthorized.js'

export interface AppDeps extends PipelineDeps {
  readiness?: () => Promise<boolean>
  /** The MCP endpoint (M4). Absent: `/p/:slug/mcp` answers 404, and the proxy still never sees it. */
  mcp?: McpDeps
  /** The request body limit on every `/p/*` request; defaults to `MAX_REQUEST_BODY_BYTES`. Tests lower it. */
  maxRequestBodyBytes?: number
}

/**
 * The largest request body `/p/*` accepts: 32 MiB, for the streaming proxy and MCP alike (follow-up
 * ruling F2). The largest legitimate body is a ComfyUI template submit carrying a base64 image
 * parameter (`/submit`, or `run_<tpl>` over MCP, which plans the same request). A worst-case,
 * incompressible 2048×2048 RGBA PNG is 16.0 MiB, 21.3 MiB as base64, so 32 MiB leaves 1.5× headroom
 * for it. MCP gets the same limit because its `run_<tpl>` carries the same payload (spec M4 D8).
 */
export const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024

function extractKey(header: string | undefined, xApiKey: string | undefined): string | null {
  // The scheme is case-insensitive (RFC 9110 §11.1), as in the admin API's bearer match.
  const bearer = header ? /^Bearer +(.+)$/i.exec(header) : null
  if (bearer) return bearer[1]!.trim()
  if (xApiKey) return xApiKey.trim()
  return null
}

/**
 * Applied to every response, including errors and 404s.
 *
 * This process relays bodies from upstream servers we do not control, so `nosniff` is the
 * one that earns its place: it stops a browser from re-interpreting a relayed body as
 * markup or script. HSTS is inert over plain HTTP (so LAN deployments are unaffected) and
 * takes effect the moment an operator puts the proxy behind TLS. There is no HTML surface
 * here, so no CSP — the control plane sets a nonce policy for that.
 */
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Strict-Transport-Security': 'max-age=63072000',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
}

function reply(c: Context, r: Refusal): Response {
  for (const [k, v] of Object.entries(r.headers ?? {})) c.header(k, v)
  return c.json(r.body, r.status as ContentfulStatusCode)
}

export function createApp(deps: AppDeps): { app: Hono; drainMeters: () => Promise<void> } {
  const app = new Hono()

  // Registered first so it wraps every route below, plus the framework's own 404 handler.
  app.use('*', async (c, next) => {
    await next()
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) c.header(key, value)
  })

  // Liveness: the process is up and serving. Cheap, dependency-free.
  app.get('/healthz', (c) => c.json({ status: 'ok' }))

  // Readiness: dependencies (DB, Redis) are reachable. 503 until they are.
  app.get('/readyz', async (c) => {
    if (!deps.readiness) return c.json({ ready: true })
    try {
      return (await deps.readiness()) ? c.json({ ready: true }) : c.json({ ready: false }, 503)
    } catch {
      return c.json({ ready: false }, 503)
    }
  })

  // Before any `/p/*` handler, so an oversized body is refused before authentication and before it
  // is buffered: a declared Content-Length is judged unread, a chunked body as it streams.
  app.use('/p/*', bodyLimit({
    maxSize: deps.maxRequestBodyBytes ?? MAX_REQUEST_BODY_BYTES,
    onError: (c) => c.json({ error: 'request body too large' }, 413),
  }))

  const pipeline = createPipeline(deps)

  // The proxy's credential: an `mm_live_` key, and nothing else (spec M4 §2). Every arm goes through
  // `unauthorizedKey`: it attaches the challenge RFC 9110 §15.5.2 requires, and collapses the two
  // refused-key reasons into one body so a 401 cannot grade a `mm_live_` guess. See `unauthorized.ts`.
  async function liveKey(c: Context): Promise<{ ok: true; key: ResolvedKey } | { ok: false; res: Response }> {
    const plaintext = extractKey(c.req.header('authorization'), c.req.header('x-api-key'))
    if (!plaintext) return { ok: false, res: unauthorizedKey('no key presented') }
    const key = await deps.configStore.resolveKeyByHash(hashApiKey(plaintext))
    if (!key) return { ok: false, res: unauthorizedKey('no key matches the presented hash') }
    if (key.expiresAt && key.expiresAt.getTime() < Date.now()) {
      return { ok: false, res: unauthorizedKey('the presented key has expired') }
    }
    return { ok: true, key }
  }

  // Before the catch-all, so `/p/:slug/mcp` is never proxied (spec M4 §4.1).
  registerMcpRoutes(app, { pipeline, configStore: deps.configStore, mcp: deps.mcp })

  // Scoped result route: see `Pipeline.jobResult`.
  app.get('/p/:slug/result/:jobId', async (c) => {
    const auth = await liveKey(c)
    if (!auth.ok) return auth.res
    const gate = await pipeline.paddockScope(auth.key, c.req.param('slug'))
    if (!gate.ok) return reply(c, gate.refusal)
    const out = await pipeline.jobResult(gate.scope, c.req.param('jobId'))
    return c.json(out.body as Record<string, unknown>, out.status as ContentfulStatusCode)
  })

  app.all('/p/:slug/*', async (c) => {
    const slug = c.req.param('slug')
    const upstreamPath = '/' + c.req.path.split('/').slice(3).join('/')

    // 1-2. Authenticate + resolve paddock + scope check.
    const auth = await liveKey(c)
    if (!auth.ok) return auth.res
    const gate = await pipeline.paddockScope(auth.key, slug)
    if (!gate.ok) return reply(c, gate.refusal)

    // 3. Rate limit, then quota.
    const limited = await pipeline.limits(gate.scope)
    if (limited) return reply(c, limited)

    // 4. Parse body + build context
    const contentType = c.req.header('content-type') ?? ''
    let body: unknown
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      body = contentType.includes('application/json')
        ? await c.req.json().catch(() => undefined)
        : await c.req.text().catch(() => undefined)
    }
    const ctx: RequestCtx = {
      method: c.req.method,
      path: upstreamPath,
      headers: contentType ? { 'content-type': contentType } : {},
      body,
      paddockSlug: slug,
    }

    // 5-7. guard → handle or proxy → meter.
    const out = await pipeline.run(gate.scope, ctx)
    if (out.kind === 'refused') return reply(c, out.refusal)
    if (out.kind === 'handled') return c.json(out.body as Record<string, unknown>, out.status as ContentfulStatusCode)
    return out.response
  })

  return { app, drainMeters: () => pipeline.drain() }
}
