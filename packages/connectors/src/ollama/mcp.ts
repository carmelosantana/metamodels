import { argsObject, byToolName, toolError, type JsonSchema, type McpCallPlan, type McpCallToolResult, type McpToolAnnotations, type McpToolDef } from '../mcp.js'
import { ollamaModelAllowed, type OllamaConstraint } from './constraint.js'

// Inference reads a model and changes nothing on the flock. Hints only — guard() enforces.
const INFERENCE: Readonly<McpToolAnnotations> = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false })
const LISTING: Readonly<McpToolAnnotations> = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })

/** A fresh object per call: tools must not share (and so co-mutate) schema nodes. */
function modelSchema(allowed: readonly string[] | null): JsonSchema {
  if (allowed === null) {
    return { type: 'string', minLength: 1, description: 'Name of an Ollama model available on this paddock.' }
  }
  return { type: 'string', enum: [...new Set(allowed)].sort(), description: 'One of the models this paddock allows.' }
}

function chatTool(allowed: readonly string[] | null): McpToolDef {
  return {
    name: 'chat',
    title: 'Chat',
    description: 'Send a conversation to a model and get the next assistant message.',
    inputSchema: {
      type: 'object',
      properties: {
        model: modelSchema(allowed),
        messages: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', enum: ['system', 'user', 'assistant'] },
              content: { type: 'string' },
            },
            required: ['role', 'content'],
            additionalProperties: false,
          },
        },
      },
      required: ['model', 'messages'],
      additionalProperties: false,
    },
    annotations: INFERENCE,
  }
}

function generateTool(allowed: readonly string[] | null): McpToolDef {
  return {
    name: 'generate',
    title: 'Generate text',
    description: 'Complete a single prompt with a model.',
    inputSchema: {
      type: 'object',
      properties: {
        model: modelSchema(allowed),
        prompt: { type: 'string' },
        system: { type: 'string', description: 'Optional system prompt.' },
      },
      required: ['model', 'prompt'],
      additionalProperties: false,
    },
    annotations: INFERENCE,
  }
}

function embedTool(allowed: readonly string[] | null): McpToolDef {
  return {
    name: 'embed',
    title: 'Embed text',
    description: 'Compute embedding vectors for one or more strings.',
    inputSchema: {
      type: 'object',
      properties: {
        model: modelSchema(allowed),
        input: { type: 'array', minItems: 1, items: { type: 'string' } },
      },
      required: ['model', 'input'],
      additionalProperties: false,
    },
    annotations: INFERENCE,
  }
}

function listModelsTool(): McpToolDef {
  return {
    name: 'list_models',
    title: 'List models',
    description: "List the models installed on this paddock's upstream. Inference tools accept only the models their model parameter allows.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: LISTING,
  }
}

/**
 * Ollama's MCP tools for one paddock (spec §4.4). A pure projection of the fence: each allowed
 * route group becomes at most one tool. `mutate` is unreachable twice over — the constraint
 * schema cannot express it, and there is no branch here for it.
 */
export function ollamaToMcp(fence: OllamaConstraint): McpToolDef[] {
  const routes = new Set(fence.allowedRoutes)
  const allowed = fence.allowedModels
  const canInfer = allowed === null || allowed.length > 0
  const tools: McpToolDef[] = []
  if (canInfer && routes.has('chat')) tools.push(chatTool(allowed))
  if (canInfer && routes.has('generate')) tools.push(generateTool(allowed))
  if (canInfer && routes.has('embed')) tools.push(embedTool(allowed))
  if (routes.has('read')) tools.push(listModelsTool())
  return tools.sort(byToolName)
}

const invalid = (why: string): McpCallPlan => ({ ok: false, error: `invalid arguments: ${why}` })

function upstreamError(result: { status: number; body: unknown }): string {
  const e = (result.body as { error?: unknown } | null)?.error
  return `upstream error (${result.status})${typeof e === 'string' && e ? `: ${e}` : ''}`
}

const CHAT_ROLES: ReadonlySet<string> = new Set(['system', 'user', 'assistant'])

/**
 * The chat tool's `messages`, rebuilt message by message from exactly what its inputSchema declares:
 * `role` (system, user or assistant) and `content`, both strings. A message carrying anything else
 * (`images`, `tool_calls`, `thinking`…) is refused, not trimmed: the schema says
 * `additionalProperties: false`, so the caller asked for something this tool does not offer.
 */
function chatMessages(v: unknown): Array<{ role: string; content: string }> | string {
  if (!Array.isArray(v) || v.length === 0) return 'messages must be a non-empty array'
  const out: Array<{ role: string; content: string }> = []
  for (const [i, m] of v.entries()) {
    const o = argsObject(m)
    if (!o) return `messages[${i}] must be an object`
    if (Object.keys(o).some((k) => k !== 'role' && k !== 'content')) return `messages[${i}] may carry only role and content`
    if (typeof o.role !== 'string' || !CHAT_ROLES.has(o.role)) return `messages[${i}].role must be system, user or assistant`
    if (typeof o.content !== 'string') return `messages[${i}].content must be a string`
    out.push({ role: o.role, content: o.content })
  }
  return out
}

/**
 * Plan an Ollama `tools/call`. The request is built only from what each tool's inputSchema declares:
 * other top-level arguments are dropped, so a caller cannot reach `options`, `keep_alive` or `format`;
 * each chat message is rebuilt from its `role` and `content`, and one carrying any other field is
 * refused; `embed`'s `input` must be strings. Anything malformed is `invalid arguments`. Inference is
 * always `stream: false` (one JSON-RPC response per call). The model is NOT checked here — `guard()`
 * does that, with the same reason string the proxy returns.
 */
export function ollamaMcpCall(name: string, args: unknown, fence: OllamaConstraint): McpCallPlan {
  if (!ollamaToMcp(fence).some((t) => t.name === name)) return { ok: false, error: `unknown tool: ${name}` }
  const a = argsObject(args)
  if (!a) return invalid('expected an object')
  if (name === 'list_models') return { ok: true, request: { method: 'GET', path: '/api/tags' } }
  if (typeof a.model !== 'string') return invalid('model must be a string')
  switch (name) {
    case 'chat': {
      const messages = chatMessages(a.messages)
      if (typeof messages === 'string') return invalid(messages)
      return { ok: true, request: { method: 'POST', path: '/api/chat', body: { model: a.model, messages, stream: false } } }
    }
    case 'generate':
      if (typeof a.prompt !== 'string') return invalid('prompt must be a string')
      if (a.system !== undefined && typeof a.system !== 'string') return invalid('system must be a string')
      return {
        ok: true,
        request: {
          method: 'POST', path: '/api/generate',
          body: { model: a.model, prompt: a.prompt, ...(a.system === undefined ? {} : { system: a.system }), stream: false },
        },
      }
    case 'embed':
      if (!Array.isArray(a.input) || a.input.length === 0) return invalid('input must be a non-empty array')
      if (!a.input.every((x) => typeof x === 'string')) return invalid('input must be an array of strings')
      return { ok: true, request: { method: 'POST', path: '/api/embed', body: { model: a.model, input: [...a.input] } } }
  }
  return { ok: false, error: `unknown tool: ${name}` }
}

/**
 * Shape the pipeline's answer as MCP content. `list_models` keeps only the models this fence allows,
 * with the same matcher `guard()` enforces (controller ruling S2): the REST `/api/tags` stays
 * unfiltered, so the narrowing happens here.
 */
export function ollamaMcpResult(name: string, result: { status: number; body: unknown }, fence: OllamaConstraint): McpCallToolResult {
  if (result.status >= 400) return toolError(upstreamError(result))
  const body = result.body
  if (typeof body !== 'object' || body === null) return toolError('the upstream answer could not be read')
  const b = body as Record<string, unknown>
  switch (name) {
    case 'chat': {
      const text = (b.message as { content?: unknown } | undefined)?.content
      return typeof text === 'string' ? { content: [{ type: 'text', text }], structuredContent: b } : toolError('the upstream answer had no message')
    }
    case 'generate':
      return typeof b.response === 'string'
        ? { content: [{ type: 'text', text: b.response }], structuredContent: b }
        : toolError('the upstream answer had no response')
    case 'embed':
      return Array.isArray(b.embeddings)
        ? { content: [{ type: 'text', text: JSON.stringify(b.embeddings) }], structuredContent: { embeddings: b.embeddings } }
        : toolError('the upstream answer had no embeddings')
    case 'list_models': {
      const names = Array.isArray(b.models)
        ? b.models.map((m) => (m as { name?: unknown } | null)?.name).filter((n): n is string => typeof n === 'string')
        : []
      const models = [...new Set(names)].filter((n) => ollamaModelAllowed(fence, n)).sort()
      return { content: [{ type: 'text', text: models.join('\n') }], structuredContent: { models } }
    }
  }
  return toolError(`unknown tool: ${name}`)
}
