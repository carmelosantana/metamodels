import { describe, expect, test } from 'vitest'
import { createApp } from '../src/app.js'
import { buildRegistry } from '../src/breeds.js'
import { InMemoryRateLimiter } from '../src/ratelimit/rate-limiter.js'
import { InMemoryMeterSink } from '../src/meter/meter-sink.js'
import { InMemoryJobStore } from '../src/jobs/job-store.js'
import type { ConfigStore } from '../src/config/config-store.js'

const stubConfig: ConfigStore = {
  resolveKeyByHash: async () => null,
  getPaddockBySlug: async () => null,
}

function make(readiness?: () => Promise<boolean>) {
  return createApp({
    configStore: stubConfig,
    rateLimiter: new InMemoryRateLimiter(),
    meterSink: new InMemoryMeterSink(),
    registry: buildRegistry(),
    jobStore: new InMemoryJobStore(),
    readiness,
  }).app
}

describe('health routes', () => {
  test('GET /healthz is always 200 (liveness)', async () => {
    const res = await make().request('/healthz')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  test('GET /readyz is 200 when the readiness probe resolves true', async () => {
    const res = await make(async () => true).request('/readyz')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ready: true })
  })

  test('GET /readyz is 503 when the readiness probe resolves false or throws', async () => {
    expect((await make(async () => false).request('/readyz')).status).toBe(503)
    expect((await make(async () => { throw new Error('down') }).request('/readyz')).status).toBe(503)
  })

  test('GET /readyz is 200 with no probe configured (nothing to check)', async () => {
    expect((await make().request('/readyz')).status).toBe(200)
  })
})
