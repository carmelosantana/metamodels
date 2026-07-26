import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { defineBreed } from '../src/breed.js'
import type {
  Breed,
  BreedHandleResult,
  BreedIO,
  JobRecord,
  JobStore,
  MeterEvent,
  RequestCtx,
} from '../src/breed.js'
import { ollamaBreed } from '../src/ollama/index.js'

// A tiny fake breed that DEFINES the optional handle hook.
const handleBreed = defineBreed<{ ok: boolean }>({
  id: 'fake-handle',
  displayName: 'Fake handle',
  routes: [{ method: 'POST', path: '/handle', class: 'infer', exposeByDefault: true }],
  constraintSchema: z.object({ ok: z.boolean().default(true) }),
  async health() { return { ok: true } },
  guard(ctx) {
    return { ok: true, request: { method: ctx.method, path: ctx.path, headers: ctx.headers, body: ctx.body } }
  },
  meter() { return [] },
  billingDimensions: ['jobs'],
  async handle(_ctx, _fence, io) {
    await io.emitMeter([{ dim: 'jobs', value: 1, at: 0 }])
    return { status: 202, body: { ids: io.ids } }
  },
})

const ctx: RequestCtx = {
  method: 'POST', path: '/handle', headers: {}, body: {}, paddockSlug: 'p',
}

// An in-memory JobStore stub to satisfy the BreedIO shape.
function makeJobStore(): JobStore {
  const store = new Map<string, JobRecord>()
  return {
    async create(job) {
      const rec: JobRecord = { ...job, metered: false }
      store.set(rec.jobId, rec)
      return rec
    },
    async get(jobId) { return store.get(jobId) ?? null },
    async markMetered(jobId) {
      const rec = store.get(jobId)
      if (!rec || rec.metered) return false
      rec.metered = true
      return true
    },
  }
}

describe('Breed.handle hook + BreedIO/JobStore types', () => {
  test('a breed defining handle echoes io.ids and emits meter events', async () => {
    const emitted: MeterEvent[][] = []
    const io: BreedIO = {
      ids: { orgId: 'o1', keyId: 'k1', paddockId: 'pad1' },
      flock: { baseUrl: 'http://up' },
      async upstream() { return { status: 200, headers: {}, body: {} } },
      async upstreamRaw() { return new Response(null, { status: 200 }) },
      async emitMeter(events) { emitted.push(events) },
      jobs: makeJobStore(),
    }

    const result: BreedHandleResult = await handleBreed.handle!(ctx, { ok: true }, io)

    expect(result.status).toBe(202)
    expect(result.body).toEqual({ ids: { orgId: 'o1', keyId: 'k1', paddockId: 'pad1' } })
    expect(emitted).toEqual([[{ dim: 'jobs', value: 1, at: 0 }]])
  })

  test('handle is optional: ollamaBreed is a valid Breed without defining it', () => {
    const b: Breed = ollamaBreed as Breed
    expect(b.handle).toBeUndefined()
  })

  test('JobStore round-trips a record and marks it metered', async () => {
    const jobs = makeJobStore()
    const created = await jobs.create({
      jobId: 'j1', keyId: 'k1', paddockId: 'pad1', orgId: 'o1',
      templateId: 't1', cost: 5, submittedAt: 123,
    })
    expect(created.metered).toBe(false)
    // markMetered is a compare-and-set: true on the winning transition, false after.
    expect(await jobs.markMetered('j1')).toBe(true)
    expect((await jobs.get('j1'))?.metered).toBe(true)
    expect(await jobs.markMetered('j1')).toBe(false)
  })
})
