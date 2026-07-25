import { z } from 'zod'
import { defineBreed } from '../breed.js'

// A trivial breed used only by tests to exercise the contract.
export const echoConstraint = z.object({ allow: z.boolean().default(true) })
export type EchoConstraint = z.infer<typeof echoConstraint>

export const echoBreed = defineBreed<EchoConstraint>({
  id: 'echo',
  displayName: 'Echo (test)',
  routes: [{ method: 'POST', path: '/echo', class: 'infer', exposeByDefault: true }],
  constraintSchema: echoConstraint,
  async health() { return { ok: true } },
  guard(ctx, fence) {
    if (!fence.allow) return { ok: false, status: 403, reason: 'not allowed' }
    return { ok: true, request: { method: ctx.method, path: ctx.path, headers: ctx.headers, body: ctx.body } }
  },
  meter(_ctx, upstream) {
    const tokens = (upstream.body as { tokens?: number }).tokens ?? 0
    return [{ dim: 'tokens_out', value: tokens, at: 0 }]
  },
  billingDimensions: ['tokens_out'],
})
