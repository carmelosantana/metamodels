import { defineBreed } from '../breed.js'
import type { Breed, GuardResult, RequestCtx, UpstreamResult, MeterEvent, ModelListResult } from '../breed.js'
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

  meter(_ctx: RequestCtx, upstream: UpstreamResult): MeterEvent[] {
    const frame = (upstream.finalFrame ?? upstream.body) as Record<string, unknown> | null
    if (!frame || typeof frame !== 'object') return []

    let tokensIn = 0
    let tokensOut = 0
    if (typeof frame.prompt_eval_count === 'number') tokensIn = frame.prompt_eval_count
    if (typeof frame.eval_count === 'number') tokensOut = frame.eval_count

    const usage = frame.usage as Record<string, unknown> | undefined
    if (usage && typeof usage === 'object') {
      if (typeof usage.prompt_tokens === 'number') tokensIn = usage.prompt_tokens
      if (typeof usage.completion_tokens === 'number') tokensOut = usage.completion_tokens
    }

    const at = Date.now()
    const events: MeterEvent[] = []
    if (tokensIn > 0) events.push({ dim: 'tokens_in', value: tokensIn, at })
    if (tokensOut > 0) events.push({ dim: 'tokens_out', value: tokensOut, at })
    return events
  },

  async health(flock) {
    try {
      const res = await fetch(`${flock.baseUrl.replace(/\/$/, '')}/api/version`)
      return { ok: res.ok }
    } catch (err) {
      return { ok: false, detail: String(err) }
    }
  },

  async listModels(flock): Promise<ModelListResult> {
    try {
      const headers: Record<string, string> = {}
      if (flock.upstreamAuth) headers['Authorization'] = flock.upstreamAuth
      const res = await fetch(`${flock.baseUrl.replace(/\/$/, '')}/api/tags`, { headers })
      if (!res.ok) return { ok: false, models: [], detail: `upstream returned HTTP ${res.status}` }
      const data = (await res.json()) as { models?: Array<{ name?: unknown }> }
      const names = Array.isArray(data.models)
        ? data.models.map((m) => m?.name).filter((n): n is string => typeof n === 'string')
        : []
      return { ok: true, models: [...new Set(names)].sort() }
    } catch (err) {
      return { ok: false, models: [], detail: String(err) }
    }
  },
})
