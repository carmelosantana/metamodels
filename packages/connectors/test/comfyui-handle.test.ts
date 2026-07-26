import { describe, expect, test } from 'vitest'
import type {
  BreedIO,
  JobRecord,
  JobStore,
  MeterEvent,
  RequestCtx,
  RewrittenRequest,
} from '../src/breed.js'
import { comfyuiBreed, comfyuiConstraint } from '../src/comfyui/index.js'
import type { WorkflowTemplate } from '../src/comfyui/template.js'

// ---- Inline fixtures (latex.pics v0.3.2-shaped, never copied from source) ----

// txt2img: a prompt (text) + a seed, cost 3.
const txt2img: WorkflowTemplate = {
  id: 'txt2img',
  cost: 3,
  graph: {
    '1': { class_type: 'CLIPTextEncode', inputs: { text: 'placeholder' } },
    '2': { class_type: 'KSampler', inputs: { seed: 0, steps: 20 } },
    '3': { class_type: 'SaveImage', inputs: { images: ['2', 0] } },
  },
  params: [
    { name: 'prompt', type: 'text', target: { node: '1', input: 'text' } },
    { name: 'seed', type: 'seed', targets: [{ node: '2', input: 'seed' }] },
  ],
}

// img2img: additionally exposes an `image` param injected into LoadImage.
const img2img: WorkflowTemplate = {
  id: 'img2img',
  cost: 5,
  graph: {
    '1': { class_type: 'CLIPTextEncode', inputs: { text: 'placeholder' } },
    '2': { class_type: 'LoadImage', inputs: { image: 'placeholder.png' } },
    '3': { class_type: 'KSampler', inputs: { seed: 0 } },
  },
  params: [
    { name: 'prompt', type: 'text', target: { node: '1', input: 'text' } },
    { name: 'image', type: 'image', target: { node: '2', input: 'image' } },
  ],
}

const fence = { templates: [txt2img, img2img] }

const ids = { orgId: 'o1', keyId: 'k1', paddockId: 'pad1' }

interface Capture {
  io: BreedIO
  submitted: RewrittenRequest[]
  uploads: { path: string; init: RequestInit }[]
  jobsCreated: Omit<JobRecord, 'metered'>[]
  meters: MeterEvent[][]
}

// A fake BreedIO exercising the real submit flow.
function makeIO(opts?: {
  uploadName?: string | null
  promptId?: string | null
}): Capture {
  const submitted: RewrittenRequest[] = []
  const uploads: { path: string; init: RequestInit }[] = []
  const jobsCreated: Omit<JobRecord, 'metered'>[] = []
  const meters: MeterEvent[][] = []
  const store = new Map<string, JobRecord>()

  const jobs: JobStore = {
    async create(job) {
      jobsCreated.push(job)
      const rec: JobRecord = { ...job, metered: false }
      store.set(rec.jobId, rec)
      return rec
    },
    async get(jobId) {
      return store.get(jobId) ?? null
    },
    async markMetered(jobId) {
      const rec = store.get(jobId)
      if (rec) rec.metered = true
    },
  }

  const io: BreedIO = {
    ids,
    flock: { baseUrl: 'http://up' },
    async upstream(req) {
      submitted.push(req)
      const promptId = opts?.promptId === undefined ? 'p1' : opts.promptId
      return {
        status: 200,
        headers: {},
        body: promptId === null ? {} : { prompt_id: promptId },
      }
    },
    async upstreamRaw(path, init) {
      uploads.push({ path, init })
      const name = opts?.uploadName === undefined ? 'up.png' : opts.uploadName
      const payload = name === null ? {} : { name }
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
    async emitMeter(events) {
      meters.push(events)
    },
    jobs,
  }

  return { io, submitted, uploads, jobsCreated, meters }
}

function ctxWith(body: unknown): RequestCtx {
  return { method: 'POST', path: '/submit', headers: {}, body, paddockSlug: 'p' }
}

describe('comfyuiConstraint', () => {
  test('embeds the operator-approved templates', () => {
    const parsed = comfyuiConstraint.parse(fence)
    expect(parsed.templates).toHaveLength(2)
    expect(parsed.templates[0]?.id).toBe('txt2img')
  })
})

describe('comfyuiBreed.guard (defense in depth)', () => {
  test('hard-denies any direct upstream route with 403', () => {
    const res = comfyuiBreed.guard(ctxWith({}), fence)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.status).toBe(403)
  })
})

describe('comfyuiBreed.handle (submit flow)', () => {
  test('valid {template_id,params} reconstructs, submits, records job, meters jobs, returns 202', async () => {
    const cap = makeIO()
    const before = Date.now()
    const res = await comfyuiBreed.handle!(
      ctxWith({ template_id: 'txt2img', params: { prompt: 'a cat' } }),
      fence,
      cap.io,
    )

    // Returns 202 with the upstream prompt id.
    expect(res.status).toBe(202)
    expect(res.body).toEqual({ job_id: 'p1' })

    // Submitted the reconstructed graph to /prompt (never a raw client graph).
    expect(cap.submitted).toHaveLength(1)
    const sub = cap.submitted[0]!
    expect(sub.method).toBe('POST')
    expect(sub.path).toBe('/prompt')
    const graph = (sub.body as { prompt: WorkflowTemplate['graph'] }).prompt
    expect(graph['1']?.inputs.text).toBe('a cat')
    // Stored template is never mutated by reconstruction.
    expect(txt2img.graph['1']?.inputs.text).toBe('placeholder')

    // Recorded the job with the right ids / templateId / cost.
    expect(cap.jobsCreated).toHaveLength(1)
    const job = cap.jobsCreated[0]!
    expect(job.jobId).toBe('p1')
    expect(job.orgId).toBe('o1')
    expect(job.keyId).toBe('k1')
    expect(job.paddockId).toBe('pad1')
    expect(job.templateId).toBe('txt2img')
    expect(job.cost).toBe(3)
    expect(job.submittedAt).toBeGreaterThanOrEqual(before)

    // Emitted exactly one jobs meter of the template cost.
    expect(cap.meters).toHaveLength(1)
    expect(cap.meters[0]).toEqual([
      { dim: 'jobs', value: 3, at: expect.any(Number) },
    ])

    // No image param supplied → no upload.
    expect(cap.uploads).toHaveLength(0)
  })

  test('an image param triggers an upstreamRaw upload and the filename reaches the graph', async () => {
    const cap = makeIO()
    const b64 = Buffer.from('fake-png-bytes').toString('base64')
    const res = await comfyuiBreed.handle!(
      ctxWith({ template_id: 'img2img', params: { prompt: 'hi', image: b64 } }),
      fence,
      cap.io,
    )

    expect(res.status).toBe(202)

    // Uploaded via multipart to /upload/image.
    expect(cap.uploads).toHaveLength(1)
    const up = cap.uploads[0]!
    expect(up.path).toBe('/upload/image')
    expect(up.init.method).toBe('POST')
    expect(up.init.body).toBeInstanceOf(FormData)
    const form = up.init.body as FormData
    expect(form.get('image')).toBeInstanceOf(Blob)

    // The returned filename ('up.png') is what lands in the LoadImage node,
    // NOT the raw base64 the client sent.
    const graph = (cap.submitted[0]!.body as { prompt: WorkflowTemplate['graph'] }).prompt
    expect(graph['2']?.inputs.image).toBe('up.png')
  })

  test('unknown template → 404', async () => {
    const cap = makeIO()
    const res = await comfyuiBreed.handle!(
      ctxWith({ template_id: 'nope', params: {} }),
      fence,
      cap.io,
    )
    expect(res.status).toBe(404)
    expect(cap.submitted).toHaveLength(0)
    expect(cap.jobsCreated).toHaveLength(0)
    expect(cap.meters).toHaveLength(0)
  })

  test('malformed body → 422', async () => {
    const cap = makeIO()
    for (const bad of [null, 'a string', { params: {} }, { template_id: 5, params: {} }, { template_id: 't', params: 7 }]) {
      const res = await comfyuiBreed.handle!(ctxWith(bad), fence, cap.io)
      expect(res.status).toBe(422)
    }
    expect(cap.submitted).toHaveLength(0)
  })

  test('unknown param (rejected by reconstructGraph) → 422', async () => {
    const cap = makeIO()
    const res = await comfyuiBreed.handle!(
      ctxWith({ template_id: 'txt2img', params: { prompt: 'ok', nope: 'bad' } }),
      fence,
      cap.io,
    )
    expect(res.status).toBe(422)
    expect(res.body).toMatchObject({ error: expect.stringContaining('nope') })
    expect(cap.submitted).toHaveLength(0)
    expect(cap.jobsCreated).toHaveLength(0)
  })

  test('upload failure (no name) → 502', async () => {
    const cap = makeIO({ uploadName: null })
    const b64 = Buffer.from('x').toString('base64')
    const res = await comfyuiBreed.handle!(
      ctxWith({ template_id: 'img2img', params: { image: b64 } }),
      fence,
      cap.io,
    )
    expect(res.status).toBe(502)
    expect(cap.submitted).toHaveLength(0)
  })

  test('no prompt_id from upstream → 502', async () => {
    const cap = makeIO({ promptId: null })
    const res = await comfyuiBreed.handle!(
      ctxWith({ template_id: 'txt2img', params: { prompt: 'ok' } }),
      fence,
      cap.io,
    )
    expect(res.status).toBe(502)
    expect(cap.jobsCreated).toHaveLength(0)
    expect(cap.meters).toHaveLength(0)
  })
})
