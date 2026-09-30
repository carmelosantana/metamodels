import type { Context, Hono } from 'hono'
import { toolError, type McpCallToolResult, type McpToolDef, type RequestCtx } from '@metamodels/connectors'
import { MCP_SCOPE, mcpResource, PADDOCK_SLUG_MAX, PADDOCK_SLUG_RE, protectedResourceMetadata } from '@metamodels/schema'
import { BodyTooLarge, bodyTooLarge } from '../body-limit.js'
import type { ConfigStore } from '../config/config-store.js'
import { refusalReason, type Pipeline, type Scope } from '../pipeline.js'
import { authenticateMcp, type McpAuthDeps } from './auth.js'
import { attachImageBytes, MCP_MAX_IMAGE_BYTES } from './job-images.js'
import {
  JSONRPC_ERRORS, MCP_CACHE_TTL_MS, MCP_SERVER_NAME, MCP_SERVER_VERSION, parseJsonRpc, rpcError, rpcResult,
  SERVER_INFO_META, SUPPORTED_PROTOCOL_VERSIONS, type JsonRpcId,
} from './jsonrpc.js'
import { eraOf, legacyNegotiatedVersion, validateLegacy, validateModern, type Era } from './protocol.js'

export interface McpDeps extends McpAuthDeps {
  /** `OIDC_ISSUER`: the authorization server this resource names in its RFC 9728 metadata. */
  oidcIssuer: string
  /** Per-result cap on inline image bytes; defaults to `MCP_MAX_IMAGE_BYTES`. */
  maxImageBytes?: number
}

/** The one planned path answered by the scoped result view rather than by `run` (ComfyUI's `get_job_result`). */
const RESULT_PATH = /^\/result\/([^/]+)$/

/** A dispatched JSON-RPC answer and the HTTP status it goes out with. */
interface Answer {
  status: number
  body: unknown
}

const ok = (id: JsonRpcId, result: unknown): Answer => ({ status: 200, body: rpcResult(id, result) })

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

const validSlug = (slug: string) => slug.length <= PADDOCK_SLUG_MAX && PADDOCK_SLUG_RE.test(slug)

/**
 * `POST /p/:slug/mcp` (spec M4 §4, D9): stateless Streamable HTTP, one JSON-RPC message per POST,
 * answered as `application/json`, for modern (2026-07-28) and legacy (2025-11-25, 2025-06-18) clients
 * alike. Order: malformed slug or MCP not configured → 404; Origin (403) → token (401/503) → body
 * (400) → notification (202) → era validation (400) → then paddock gates (unknown/inactive 404,
 * upstream credential 503) → dispatch. `Mcp-Session-Id` and `Last-Event-ID` are never read and
 * no session id is ever sent. Must be registered before `ALL /p/:slug/*`, and so must the reserved `/p/:slug/mcp/*` (404, ruling F1).
 */
export function registerMcpRoutes(app: Hono, deps: { pipeline: Pipeline; configStore: ConfigStore; mcp?: McpDeps }): void {
  const { pipeline } = deps

  // RFC 9728 §3: served without auth — there is no key to rate-limit on, and the document is static
  // per slug, read from the (cached) config. An unknown or inactive paddock is 404, as on the endpoint.
  app.get('/.well-known/oauth-protected-resource/p/:slug/mcp', async (c) => {
    const slug = c.req.param('slug')
    const mcp = deps.mcp
    if (!mcp || !validSlug(slug)) return c.json({ error: 'not found' }, 404)
    const paddock = await deps.configStore.getPaddockBySlug(slug)
    if (!paddock || paddock.status !== 'active') return c.json({ error: 'not found' }, 404)
    return c.json(protectedResourceMetadata(mcpResource(mcp.dataPlaneUrl, slug), mcp.oidcIssuer, [MCP_SCOPE]))
  })

  app.post('/p/:slug/mcp', async (c) => {
    const slug = c.req.param('slug')
    const mcp = deps.mcp
    if (!mcp || !validSlug(slug)) return c.json({ error: 'not found' }, 404)

    // 2026-07-28 streamable-http §Security: an Origin that is present and not ours is DNS rebinding
    // until proven otherwise. The body MAY be a JSON-RPC error with no id. No Origin is allowed.
    const origin = c.req.header('origin')
    if (origin !== undefined && origin !== new URL(mcp.dataPlaneUrl).origin) {
      return json({ jsonrpc: '2.0', error: { code: JSONRPC_ERRORS.invalidRequest, message: 'Origin not allowed' } }, 403)
    }

    const auth = await authenticateMcp(c.req.header('authorization'), slug, mcp, deps.configStore)
    if (!auth.ok) return auth.res

    let raw: unknown
    try {
      raw = JSON.parse(await c.req.text())
    } catch (err) {
      if (err instanceof BodyTooLarge) return bodyTooLarge(c)
      return json(rpcError(null, JSONRPC_ERRORS.parseError, 'parse error'), 400)
    }
    const msg = parseJsonRpc(raw)
    if (msg.kind === 'invalid') return json(rpcError(msg.id, JSONRPC_ERRORS.invalidRequest, msg.message), 400)
    // Nothing here acts on a notification (`notifications/initialized`, `notifications/cancelled`…):
    // accepted with 202 and no body, in either era. 2026-07-28 defines no headers for notification POSTs.
    if (msg.kind === 'notification') return new Response(null, { status: 202 })

    const header = (name: string) => c.req.header(name)
    const era = eraOf(msg.method, msg.params, header('mcp-protocol-version'))
    const refused = era === 'modern'
      ? validateModern(msg.id, msg.method, msg.params, header)
      : validateLegacy(msg.id, msg.method, header)
    if (refused) return json(refused.body, refused.status)

    const gate = await pipeline.paddockScope(auth.key, slug)
    if (!gate.ok) return json(gate.refusal.body, gate.refusal.status, gate.refusal.headers)

    const answer = await dispatch(era, msg.id, msg.method, msg.params, gate.scope, slug, mcp)
    return json(answer.body, answer.status)
  })

  // Stateless: no SSE stream to GET, no session to DELETE (2026-07-28 streamable-http §Backward Compatibility).
  app.all('/p/:slug/mcp', (c: Context) => {
    if (!deps.mcp) return c.json({ error: 'not found' }, 404)
    c.header('allow', 'POST')
    return c.json({ error: 'method not allowed' }, 405)
  })

  // `/p/:slug/mcp/` and everything beneath it is no endpoint, whatever the method (follow-up ruling F1):
  // the resource is compared exactly, so no token names it, and the proxy catch-all must never see it.
  app.all('/p/:slug/mcp/*', (c: Context) => c.json({ error: 'not found' }, 404))

  async function dispatch(era: Era, id: JsonRpcId, method: string, params: unknown, scope: Scope, slug: string, mcp: McpDeps): Promise<Answer> {
    const { paddock, breed } = scope
    const fence = breed.constraintSchema.safeParse(paddock.fence.constraintJson)
    if (!fence.success) return { status: 200, body: rpcError(id, JSONRPC_ERRORS.internalError, "this paddock's fence is invalid") }
    const tools = breed.toMcp?.(fence.data) ?? []
    const call = () => toolsCall(id, params, tools, fence.data, scope, slug, mcp)
    return era === 'modern' ? modern(id, method, tools, call) : legacy(id, method, params, paddock.name, tools, call)
  }

  /** 2026-07-28: every result carries `resultType` and `serverInfo`; discover and list are cacheable, per caller. */
  async function modern(id: JsonRpcId, method: string, tools: McpToolDef[], call: () => Promise<Answer | McpCallToolResult>): Promise<Answer> {
    const _meta = { [SERVER_INFO_META]: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION } }
    switch (method) {
      case 'server/discover':
        return ok(id, {
          resultType: 'complete',
          supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
          capabilities: { tools: {} },
          _meta,
          ttlMs: MCP_CACHE_TTL_MS,
          cacheScope: 'private',
        })
      case 'tools/list':
        // No pagination: the lists are small, and a `cursor` is ignored (spec M4 §4.1).
        return ok(id, { resultType: 'complete', tools, ttlMs: MCP_CACHE_TTL_MS, cacheScope: 'private', _meta })
      case 'tools/call': {
        const out = await call()
        return 'status' in out ? out : ok(id, { resultType: 'complete', ...out, _meta })
      }
      default:
        // 2026-07-28 streamable-http §Protocol Version Header: an unimplemented method is HTTP 404 + -32601.
        return { status: 404, body: rpcError(id, JSONRPC_ERRORS.methodNotFound, `method not found: ${method}`) }
    }
  }

  /** 2025-11-25 / 2025-06-18, stateless: the handshake is answered, never remembered. */
  async function legacy(
    id: JsonRpcId, method: string, params: unknown, title: string, tools: McpToolDef[], call: () => Promise<Answer | McpCallToolResult>,
  ): Promise<Answer> {
    switch (method) {
      case 'initialize':
        return ok(id, {
          protocolVersion: legacyNegotiatedVersion((params as { protocolVersion?: unknown } | undefined)?.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, title, version: MCP_SERVER_VERSION },
        })
      case 'ping':
        return ok(id, {})
      case 'tools/list':
        return ok(id, { tools })
      case 'tools/call': {
        const out = await call()
        return 'status' in out ? out : ok(id, out)
      }
      default:
        return { status: 200, body: rpcError(id, JSONRPC_ERRORS.methodNotFound, `method not found: ${method}`) }
    }
  }

  /** Shared by both eras: a JSON-RPC error `Answer` for a call that names no tool, else the tool's result. */
  async function toolsCall(
    id: JsonRpcId, params: unknown, tools: McpToolDef[], fence: unknown, scope: Scope, slug: string, mcp: McpDeps,
  ): Promise<Answer | McpCallToolResult> {
    const p = (params ?? {}) as { name?: unknown; arguments?: unknown }
    if (typeof p.name !== 'string') return { status: 200, body: rpcError(id, JSONRPC_ERRORS.invalidParams, 'params.name must be a string') }
    if (!tools.some((t) => t.name === p.name)) return { status: 200, body: rpcError(id, JSONRPC_ERRORS.invalidParams, `Unknown tool: ${p.name}`) }
    return callTool(p.name, p.arguments ?? {}, fence, scope, slug, mcp)
  }

  async function callTool(name: string, args: unknown, fence: unknown, scope: Scope, slug: string, mcp: McpDeps): Promise<McpCallToolResult> {
    const { breed } = scope
    if (!breed.mcpCall || !breed.mcpResult) return toolError('this paddock cannot run tools')

    // Every tools/call, get_job_result included, is rate-limited and quota-checked (spec M4 §1), in either era.
    const limited = await pipeline.limits(scope)
    if (limited) return toolError(refusalReason(limited))

    const plan = breed.mcpCall(name, args, fence)
    if (!plan.ok) return toolError(plan.error)
    const shape = (r: { status: number; body: unknown }) => breed.mcpResult!(name, r, fence)

    try {
      const result = plan.request.method === 'GET' ? RESULT_PATH.exec(plan.request.path) : null
      if (result) {
        const out = await pipeline.jobResult(scope, decodeURIComponent(result[1]!))
        if (out.status !== 200) return shape(out)
        const attached = await attachImageBytes(out.body, (path) => pipeline.raw(scope, path, { method: 'GET' }), mcp.maxImageBytes ?? MCP_MAX_IMAGE_BYTES)
        return attached.ok ? shape({ status: 200, body: attached.body }) : toolError(attached.error)
      }

      const { method, path, body } = plan.request
      const ctx: RequestCtx = {
        method, path, body, paddockSlug: slug,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
      }
      const out = await pipeline.run(scope, ctx)
      if (out.kind === 'refused') return toolError(refusalReason(out.refusal))
      if (out.kind === 'handled') return shape({ status: out.status, body: out.body })
      // The client branch of the tee is not needed: MCP answers from the metering branch. Not awaited —
      // a tee branch's cancel settles only once both branches are done.
      out.response.body?.cancel().catch(() => undefined)
      const upstream = await out.metering
      return shape({ status: upstream.status, body: upstream.body })
    } catch (e) {
      console.error(`[mcp] tools/call ${name} on ${slug}: upstream failed: ${String(e)}`)
      return toolError('the upstream could not be reached')
    }
  }
}
