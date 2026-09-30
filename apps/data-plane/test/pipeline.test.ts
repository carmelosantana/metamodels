import { describe, expect, test } from 'vitest'
import { buildRegistry } from '../src/breeds.js'
import type { ConfigStore } from '../src/config/config-store.js'
import type { ResolvedKey, ResolvedPaddock } from '../src/config/types.js'
import { InMemoryJobStore } from '../src/jobs/job-store.js'
import { InMemoryMeterSink } from '../src/meter/meter-sink.js'
import { createPipeline } from '../src/pipeline.js'
import { InMemoryRateLimiter } from '../src/ratelimit/rate-limiter.js'

const key = (over: Partial<ResolvedKey> = {}): ResolvedKey => ({
  keyId: 'k1', orgId: 'o1', status: 'active', expiresAt: null, paddockSlugs: ['small'], overrides: null, ...over,
})
const paddock = (over: Partial<ResolvedPaddock> = {}): ResolvedPaddock => ({
  paddockId: 'p1', orgId: 'o1', slug: 'small', name: 'Small models', status: 'active', breedId: 'ollama',
  flock: { baseUrl: 'http://fake.ollama', upstreamAuth: null, tlsTrust: false },
  fence: { constraintJson: { allowedRoutes: ['chat'], allowedModels: null }, rateLimit: null, quota: null },
  ...over,
})

/** The pipeline over a config store that knows at most one paddock. */
function pipelineWith(p: ResolvedPaddock | null) {
  const configStore: ConfigStore = {
    resolveKeyByHash: async () => null,
    resolveKeyById: async () => null,
    getPaddockBySlug: async (slug) => (p !== null && p.slug === slug ? p : null),
  }
  return createPipeline({
    configStore, rateLimiter: new InMemoryRateLimiter(), meterSink: new InMemoryMeterSink(), registry: buildRegistry(), jobStore: new InMemoryJobStore(),
  })
}

describe('Pipeline.paddockScope, each gate alone (spec M4 §4.2 step 4)', () => {
  test('an active paddock the key is scoped to opens, with its breed', async () => {
    const out = await pipelineWith(paddock()).paddockScope(key(), 'small')
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.scope.breed.id).toBe('ollama')
  })

  test('an unknown or inactive paddock is 404, before the scope is looked at', async () => {
    const unscoped = key({ paddockSlugs: [] })
    for (const p of [null, paddock({ status: 'disabled' })]) {
      expect(await pipelineWith(p).paddockScope(unscoped, 'small'))
        .toEqual({ ok: false, refusal: { status: 404, body: { error: 'unknown paddock' } } })
    }
  })

  test('a key not scoped to the paddock is 403', async () => {
    expect(await pipelineWith(paddock()).paddockScope(key({ paddockSlugs: ['other'] }), 'small'))
      .toEqual({ ok: false, refusal: { status: 403, body: { error: 'key not scoped to paddock' } } })
  })

  test('an upstream credential that cannot be opened is 503, and only a scoped key learns it', async () => {
    const broken = pipelineWith(paddock({ upstreamAuthError: 'unknown-key' }))
    expect(await broken.paddockScope(key(), 'small'))
      .toEqual({ ok: false, refusal: { status: 503, body: { error: 'upstream credential unavailable' } } })
    expect(await broken.paddockScope(key({ paddockSlugs: ['other'] }), 'small'))
      .toMatchObject({ ok: false, refusal: { status: 403 } })
  })
})
