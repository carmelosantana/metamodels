import { defineBreed } from '../breed.js'
import type { Breed, GuardResult, RequestCtx, UpstreamResult, MeterEvent } from '../breed.js'
import { ollamaConstraint, routeGroup } from './constraint.js'
import type { OllamaConstraint } from './constraint.js'

export const ollamaBreed: Breed<OllamaConstraint> = defineBreed<OllamaConstraint>({
  id: 'ollama',
  displayName: 'Ollama',
  routes: [
    { method: 'POST', path: '/api/chat', class: 'infer', exposeByDefault: true },
    { method: 'POST', path: '/api/generate', class: 'infer', exposeByDefault: true },
    { method: 'POST', path: '/api/embed', class: 'infer', exposeByDefault: true },
    { method: 'GET', path: '/api/tags', class: 'read', exposeByDefault: true },
    { method: 'POST', path: '/api/pull', class: 'mutate', exposeByDefault: false },
    { method: 'DELETE', path: '/api/delete', class: 'mutate', exposeByDefault: false },
  ],
  constraintSchema: ollamaConstraint,
  billingDimensions: ['tokens_in', 'tokens_out'],

  guard(ctx: RequestCtx, fence: OllamaConstraint): GuardResult {
    const group = routeGroup(ctx.path)
    if (group === 'mutate') {
      return { ok: false, status: 403, reason: 'model-management endpoints are not permitted' }
    }
    if (group === 'unknown') {
      return { ok: false, status: 403, reason: `route not permitted: ${ctx.path}` }
    }
    if (!fence.allowedRoutes.includes(group)) {
      return { ok: false, status: 403, reason: `route group '${group}' is not allowed by this paddock` }
    }

    let body = ctx.body
    if (group !== 'read') {
      const model = (body as { model?: unknown } | null)?.model
      if (fence.allowedModels !== null) {
        if (typeof model !== 'string' || !fence.allowedModels.includes(model)) {
          return { ok: false, status: 403, reason: `model not allowed: ${typeof model === 'string' ? model : '(none)'}` }
        }
      }
      if (ctx.path.startsWith('/v1/') && (body as { stream?: unknown } | null)?.stream === true) {
        const b = body as Record<string, unknown>
        body = { ...b, stream_options: { ...(b.stream_options as object ?? {}), include_usage: true } }
      }
    }
    return { ok: true, request: { method: ctx.method, path: ctx.path, headers: ctx.headers, body } }
  },

  // Filled in Task 2.
  meter(_ctx: RequestCtx, _upstream: UpstreamResult): MeterEvent[] {
    return []
  },
  async health() {
    return { ok: true }
  },
})
