import { byToolName, type JsonSchema, type McpToolAnnotations, type McpToolDef } from '../mcp.js'
import type { OllamaConstraint } from './constraint.js'

// Inference reads a model and changes nothing on the flock. Hints only — guard() enforces.
const INFERENCE: McpToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }
const LISTING: McpToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }

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
    description: 'List the models this paddock can use.',
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
