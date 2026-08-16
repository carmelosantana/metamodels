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

function make() {
  return createApp({
    configStore: stubConfig,
    rateLimiter: new InMemoryRateLimiter(),
    meterSink: new InMemoryMeterSink(),
    registry: buildRegistry(),
    jobStore: new InMemoryJobStore(),
  }).app
}

/**
 * The data plane is the internet-facing surface: it answers unauthenticated requests and
 * relays bodies from upstream servers we do not control (Ollama, ComfyUI). These headers
 * are what stop a browser from re-interpreting such a body as markup.
 */
describe('security headers', () => {
  test('sets nosniff and HSTS on a successful response', async () => {
    const res = await make().request('/healthz')
    expect(res.status).toBe(200)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=63072000')
  })

  test('sets them on rejected requests too', async () => {
    // An unauthenticated proxy call — the error path must be hardened, not just the happy one.
    const res = await make().request('/v1/chat/completions', { method: 'POST', body: '{}' })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=63072000')
  })

  test('sets them on unmatched routes', async () => {
    const res = await make().request('/definitely-not-a-route')
    expect(res.status).toBe(404)
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  test('refuses to be framed and advertises no referrer to other origins', async () => {
    const res = await make().request('/healthz')
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer')
  })
})
