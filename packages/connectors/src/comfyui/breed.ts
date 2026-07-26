import { z } from 'zod'
import { defineBreed } from '../breed.js'
import type {
  Breed,
  BreedHandleResult,
  BreedIO,
  GuardResult,
  MeterEvent,
  RequestCtx,
  UpstreamResult,
} from '../breed.js'
import { reconstructGraph } from './template.js'
import type { ParamSpec, WorkflowTemplate } from './template.js'

// ---- Constraint (Fence) schema ----------------------------------------------
//
// The operator embeds their approved workflow templates for this Paddock. The
// consumer never submits a raw graph — only a `template_id` + `params` chosen
// from the templates the Fence declares here.

const targetSchema = z.object({ node: z.string(), input: z.string() })

const paramSpecSchema: z.ZodType<ParamSpec> = z.discriminatedUnion('type', [
  z.object({ name: z.string(), type: z.literal('text'), target: targetSchema }),
  z.object({ name: z.string(), type: z.literal('seed'), targets: z.array(targetSchema) }),
  z.object({
    name: z.string(),
    type: z.literal('number'),
    target: targetSchema,
    min: z.number().optional(),
    max: z.number().optional(),
  }),
  z.object({ name: z.string(), type: z.literal('image'), target: targetSchema }),
]) as z.ZodType<ParamSpec>

const workflowTemplateSchema: z.ZodType<WorkflowTemplate> = z.object({
  id: z.string(),
  graph: z.record(
    z.object({ class_type: z.string(), inputs: z.record(z.unknown()) }),
  ),
  params: z.array(paramSpecSchema),
  cost: z.number(),
}) as z.ZodType<WorkflowTemplate>

export const comfyuiConstraint = z.object({
  templates: z.array(workflowTemplateSchema).default([]),
})

export type ComfyConstraint = z.infer<typeof comfyuiConstraint>

// ---- Ingress body schema ----------------------------------------------------

const submitBody = z.object({
  template_id: z.string(),
  params: z.record(z.unknown()),
})

function err(status: number, message: string): BreedHandleResult {
  return { status, body: { error: message } }
}

/**
 * Upload one base64-encoded image to ComfyUI's `/upload/image` as multipart and
 * return the filename the server assigned. The consumer's base64 is decoded to
 * bytes, wrapped in a Blob, and sent as the `image` FormData field — the exact
 * shape ComfyUI expects from its own web UI.
 *
 * Returns the filename, or `null` on any upstream failure / missing name so the
 * caller can map it to a 502.
 */
async function uploadImage(
  io: BreedIO,
  name: string,
  base64: string,
): Promise<string | null> {
  let bytes: Uint8Array<ArrayBuffer>
  try {
    // Copy into a fresh ArrayBuffer-backed view so it is a valid BlobPart
    // (a Node Buffer is backed by ArrayBufferLike, which Blob won't accept).
    const buf = Buffer.from(base64, 'base64')
    bytes = new Uint8Array(new ArrayBuffer(buf.length))
    bytes.set(buf)
  } catch {
    return null
  }

  const form = new FormData()
  form.append('image', new Blob([bytes]), name)
  // ComfyUI overwrites by filename when told to; keep uploads idempotent.
  form.append('overwrite', 'true')

  let res: Response
  try {
    res = await io.upstreamRaw('/upload/image', { method: 'POST', body: form })
  } catch {
    return null
  }
  if (!res.ok) return null

  let json: unknown
  try {
    json = await res.json()
  } catch {
    return null
  }
  const filename = (json as { name?: unknown } | null)?.name
  return typeof filename === 'string' && filename.length > 0 ? filename : null
}

// ---- Breed ------------------------------------------------------------------

export const comfyuiBreed: Breed<ComfyConstraint> = defineBreed<ComfyConstraint>({
  id: 'comfyui',
  displayName: 'ComfyUI',
  routes: [
    // ComfyUI's own upstream endpoints. None are exposed directly: the app only
    // ever calls `handle`, and `guard` (below) hard-denies all of them.
    { method: 'POST', path: '/prompt', class: 'infer', exposeByDefault: false },
    { method: 'POST', path: '/upload/image', class: 'mutate', exposeByDefault: false },
    { method: 'GET', path: '/history', class: 'read', exposeByDefault: false },
    { method: 'GET', path: '/view', class: 'read', exposeByDefault: false },
  ],
  constraintSchema: comfyuiConstraint,
  billingDimensions: ['jobs', 'gpu_ms', 'images'],

  // Defense in depth: the data plane routes ComfyUI requests to `handle`, never
  // through guard→proxy→meter. But if `guard` is ever reached, it must reject —
  // a consumer must never be able to hit a raw ComfyUI route directly.
  guard(_ctx: RequestCtx, _fence: ComfyConstraint): GuardResult {
    return { ok: false, status: 403, reason: 'direct comfyui routes are not permitted; use the template submit flow' }
  },

  // ComfyUI meters from `/history` at result time (Task 8), not from the submit
  // response. The submit-time `jobs` meter is emitted inside `handle`.
  meter(_ctx: RequestCtx, _upstream: UpstreamResult): MeterEvent[] {
    return []
  },

  async health(flock) {
    try {
      const res = await fetch(`${flock.baseUrl.replace(/\/$/, '')}/system_stats`)
      return { ok: res.ok }
    } catch (e) {
      return { ok: false, detail: String(e) }
    }
  },

  async handle(ctx: RequestCtx, fence: ComfyConstraint, io: BreedIO): Promise<BreedHandleResult> {
    // 1. Parse ingress: only { template_id, params } is ever accepted.
    const parsed = submitBody.safeParse(ctx.body)
    if (!parsed.success) return err(422, 'malformed request: expected { template_id, params }')
    const { template_id, params } = parsed.data

    // 2. Find the operator-approved template.
    const tpl = fence.templates.find((t) => t.id === template_id)
    if (!tpl) return err(404, `unknown template: ${template_id}`)

    // 3. Upload each supplied image param and collect the trusted filenames.
    const uploads: Record<string, string> = {}
    for (const spec of tpl.params) {
      if (spec.type !== 'image') continue
      if (!Object.prototype.hasOwnProperty.call(params, spec.name)) continue
      const raw = params[spec.name]
      if (typeof raw !== 'string') {
        return err(422, `param '${spec.name}' must be a base64 image string`)
      }
      const filename = await uploadImage(io, `${spec.name}.png`, raw)
      if (filename === null) return err(502, `image upload failed for param '${spec.name}'`)
      uploads[spec.name] = filename
    }

    // 4. Reconstruct the full graph server-side. Undeclared params are rejected
    //    here — the consumer can never inject raw node structure.
    const built = reconstructGraph(tpl, params, { uploads })
    if (!built.ok) return err(422, built.reason)

    // 5. Submit the reconstructed graph to ComfyUI's /prompt.
    const submit = await io.upstream({
      method: 'POST',
      path: '/prompt',
      headers: { 'content-type': 'application/json' },
      body: { prompt: built.graph },
    })
    const promptId = (submit.body as { prompt_id?: unknown } | null)?.prompt_id
    if (typeof promptId !== 'string' || promptId.length === 0) {
      return err(502, 'upstream did not return a prompt_id')
    }

    // 6. Record job ownership (keyed by prompt_id) for the scoped result route.
    const now = Date.now()
    await io.jobs.create({
      jobId: promptId,
      orgId: io.ids.orgId,
      keyId: io.ids.keyId,
      paddockId: io.ids.paddockId,
      templateId: template_id,
      cost: tpl.cost,
      submittedAt: now,
    })

    // 7. Meter one `jobs` unit weighted by the template cost. images/gpu_ms are
    //    metered later from /history (Task 8) — never here.
    await io.emitMeter([{ dim: 'jobs', value: tpl.cost, at: now }])

    // 8. Accepted — the consumer polls the scoped result route with this id.
    return { status: 202, body: { job_id: promptId } }
  },
})
