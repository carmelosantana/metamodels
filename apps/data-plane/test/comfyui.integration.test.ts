import { beforeEach, describe, expect, test } from 'vitest'
import * as schema from '@metamodels/schema'
import { hashApiKey } from '@metamodels/schema'
import { createApp } from '../src/app.js'
import { buildRegistry } from '../src/breeds.js'
import { DrizzleConfigStore } from '../src/config/config-store.js'
import { InMemoryRateLimiter } from '../src/ratelimit/rate-limiter.js'
import { InMemoryMeterSink } from '../src/meter/meter-sink.js'
import { InMemoryJobStore } from '../src/jobs/job-store.js'
import { createFakeComfyui } from './helpers/fake-comfyui.js'
import { makeDb, type TestDb } from './helpers/seed.js'

// --- Fixtures: inline v0.3.2-shaped templates (never copy latex.pics JSON) ----

const txt2img = {
  id: 'txt2img',
  graph: {
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'placeholder', clip: ['4', 1] } },
    '3': {
      class_type: 'KSampler',
      inputs: { seed: 0, steps: 20, cfg: 8, model: ['4', 0], positive: ['6', 0], latent_image: ['5', 0] },
    },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'out', images: ['8', 0] } },
  },
  params: [
    { name: 'prompt', type: 'text', target: { node: '6', input: 'text' } },
    { name: 'seed', type: 'seed', targets: [{ node: '3', input: 'seed' }] },
  ],
  cost: 3,
}

const img2img = {
  id: 'img2img',
  graph: {
    '10': { class_type: 'LoadImage', inputs: { image: 'default.png' } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'placeholder', clip: ['4', 1] } },
    '3': { class_type: 'KSampler', inputs: { seed: 0, model: ['4', 0], positive: ['6', 0] } },
    '9': { class_type: 'SaveImage', inputs: { images: ['8', 0] } },
  },
  params: [
    { name: 'prompt', type: 'text', target: { node: '6', input: 'text' } },
    { name: 'seed', type: 'seed', targets: [{ node: '3', input: 'seed' }] },
    { name: 'image', type: 'image', target: { node: '10', input: 'image' } },
  ],
  cost: 5,
}

interface CfFixture {
  orgId: string
  paddockId: string
  ownerKeyId: string
  ownerKey: string
  otherKey: string
  slug: string
}

async function seedComfyui(db: TestDb): Promise<CfFixture> {
  const [org] = await db.insert(schema.org).values({ name: 'default' }).returning()
  const [flock] = await db
    .insert(schema.flock)
    .values({ orgId: org.id, breed: 'comfyui', name: 'gpu', baseUrl: 'http://fake.comfyui' })
    .returning()
  const [paddock] = await db
    .insert(schema.paddock)
    .values({ orgId: org.id, flockId: flock.id, slug: 'cf', name: 'ComfyUI paddock' })
    .returning()
  await db.insert(schema.fence).values({
    orgId: org.id,
    paddockId: paddock.id,
    constraintJson: { templates: [txt2img, img2img] },
    rateLimit: { windowSec: 60, max: 100 },
    quota: null,
  })

  const ownerKey = 'mm_live_ownerkey'
  const [owner] = await db
    .insert(schema.apiKey)
    .values({ orgId: org.id, name: 'owner', prefix: ownerKey.slice(0, 12), hash: hashApiKey(ownerKey), status: 'active' })
    .returning()
  await db.insert(schema.keyPaddock).values({ keyId: owner.id, paddockId: paddock.id })

  const otherKey = 'mm_live_otherkey'
  const [other] = await db
    .insert(schema.apiKey)
    .values({ orgId: org.id, name: 'other', prefix: otherKey.slice(0, 12), hash: hashApiKey(otherKey), status: 'active' })
    .returning()
  // Same paddock scope, so scope-check passes and only job ownership differs.
  await db.insert(schema.keyPaddock).values({ keyId: other.id, paddockId: paddock.id })

  return { orgId: org.id, paddockId: paddock.id, ownerKeyId: owner.id, ownerKey, otherKey, slug: 'cf' }
}

let fx: CfFixture
let sink: InMemoryMeterSink
let fake: ReturnType<typeof createFakeComfyui>
let app: ReturnType<typeof createApp>['app']
let drainMeters: () => Promise<void>

beforeEach(async () => {
  const db = await makeDb()
  fx = await seedComfyui(db)
  sink = new InMemoryMeterSink()
  fake = createFakeComfyui()
  const built = createApp({
    configStore: new DrizzleConfigStore(db),
    rateLimiter: new InMemoryRateLimiter(),
    meterSink: sink,
    registry: buildRegistry(),
    jobStore: new InMemoryJobStore(),
    fetchImpl: (url, init) => fake.request(url, init),
  })
  app = built.app
  drainMeters = built.drainMeters
})

function call(path: string, init: RequestInit = {}, key = fx.ownerKey) {
  const headers = new Headers(init.headers)
  if (key) headers.set('authorization', `Bearer ${key}`)
  return app.request(`http://dp.local${path}`, { ...init, headers })
}

function submit(
  key = fx.ownerKey,
  templateId = 'txt2img',
  params: Record<string, unknown> = { prompt: 'a cat' },
) {
  return call(
    '/p/cf/submit',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ template_id: templateId, params }) },
    key,
  )
}

const dims = (dim: string) => sink.events.filter((e) => e.dim === dim)

describe('data-plane comfyui integration', () => {
  test('submit a template job → 202 {job_id} + a jobs meter weighted by cost', async () => {
    const res = await submit()
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ job_id: 'cf-1' })

    await drainMeters()
    expect(dims('jobs')).toHaveLength(1)
    expect(dims('jobs')[0]).toMatchObject({
      orgId: fx.orgId,
      keyId: fx.ownerKeyId,
      paddockId: fx.paddockId,
      breedId: 'comfyui',
      value: 3,
    })
  })

  test('full result lifecycle: pending → complete, images/gpu_ms metered exactly once', async () => {
    await (await submit()).json()
    await drainMeters()

    // Before completion: scoped view says not done, no images/gpu meters.
    const r1 = await call('/p/cf/result/cf-1')
    expect(r1.status).toBe(200)
    expect(await r1.json()).toEqual({ done: false, images: [] })
    await drainMeters()
    expect(dims('images')).toHaveLength(0)
    expect(dims('gpu_ms')).toHaveLength(0)

    // Flip the job to complete upstream.
    fake.complete('cf-1')

    const r2 = await call('/p/cf/result/cf-1')
    expect(r2.status).toBe(200)
    const b2 = (await r2.json()) as { done: boolean; images: unknown[] }
    expect(b2.done).toBe(true)
    expect(b2.images).toHaveLength(2)
    await drainMeters()
    expect(dims('images')).toHaveLength(1)
    expect(dims('images')[0].value).toBe(2)
    expect(dims('gpu_ms')).toHaveLength(1)
    expect(dims('gpu_ms')[0].value).toBe(500)

    // Second fetch after metered: still done, but NO additional meters.
    const r3 = await call('/p/cf/result/cf-1')
    expect(r3.status).toBe(200)
    expect(((await r3.json()) as { done: boolean }).done).toBe(true)
    await drainMeters()
    expect(dims('images')).toHaveLength(1)
    expect(dims('gpu_ms')).toHaveLength(1)
  })

  test('result never leaks the raw /history or a /view url — only {done, images}', async () => {
    await (await submit()).json()
    fake.complete('cf-1')
    const res = await call('/p/cf/result/cf-1')
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['done', 'images'])
    const imgs = body.images as Record<string, unknown>[]
    // Scoped filenames only; never a fully-qualified /view URL.
    for (const img of imgs) {
      expect(typeof img.filename).toBe('string')
      expect(String(img.filename)).not.toContain('/view')
    }
  })

  test("result for another key's job → 404 (does not leak existence as 403)", async () => {
    await (await submit(fx.ownerKey)).json()
    const res = await call('/p/cf/result/cf-1', {}, fx.otherKey)
    expect(res.status).toBe(404)
  })

  test('result for a job that does not exist → 404', async () => {
    const res = await call('/p/cf/result/nope')
    expect(res.status).toBe(404)
  })

  test('bypass attempt: raw POST /p/:slug/prompt → 403 (guard denies direct routes)', async () => {
    const res = await call('/p/cf/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: { '1': { class_type: 'KSampler', inputs: {} } } }),
    })
    expect(res.status).toBe(403)
  })

  test('img2img: an image param is uploaded and the job submits → 202', async () => {
    const b64 = Buffer.from('not-a-real-png').toString('base64')
    const res = await submit(fx.ownerKey, 'img2img', { prompt: 'a dog', image: b64 })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ job_id: 'cf-1' })
  })
})
