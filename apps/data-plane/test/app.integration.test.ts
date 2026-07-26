import { beforeEach, describe, expect, test } from 'vitest'
import { createApp } from '../src/app.js'
import { buildRegistry } from '../src/breeds.js'
import { DrizzleConfigStore } from '../src/config/config-store.js'
import { InMemoryRateLimiter } from '../src/ratelimit/rate-limiter.js'
import { InMemoryMeterSink } from '../src/meter/meter-sink.js'
import { createFakeOllama } from './helpers/fake-ollama.js'
import { makeDb, seedFixture, type Fixture } from './helpers/seed.js'

let fx: Fixture
let sink: InMemoryMeterSink
let app: ReturnType<typeof createApp>['app']
let drainMeters: () => Promise<void>

beforeEach(async () => {
  const db = await makeDb()
  fx = await seedFixture(db)
  sink = new InMemoryMeterSink()
  const fake = createFakeOllama()
  const built = createApp({
    configStore: new DrizzleConfigStore(db),
    rateLimiter: new InMemoryRateLimiter(),
    meterSink: sink,
    registry: buildRegistry(),
    fetchImpl: (url, init) => fake.request(url, init),
  })
  app = built.app
  drainMeters = built.drainMeters
})

function call(path: string, init: RequestInit = {}, key = fx.keyPlaintext) {
  const headers = new Headers(init.headers)
  if (key) headers.set('authorization', `Bearer ${key}`)
  return app.request(`http://dp.local${path}`, { ...init, headers })
}
const chat = (model: string) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
})

describe('data-plane /p/:slug', () => {
  test('401 without a key', async () => {
    const res = await call('/p/small/api/chat', { ...chat('llama3.2:1b') }, '')
    expect(res.status).toBe(401)
  })

  test('401 with an unknown key', async () => {
    const res = await call('/p/small/api/chat', chat('llama3.2:1b'), 'mm_live_wrong')
    expect(res.status).toBe(401)
  })

  test('404 for an unknown paddock slug', async () => {
    const res = await call('/p/ghost/api/chat', chat('llama3.2:1b'))
    expect(res.status).toBe(404)
  })

  test('403 for a model-management (MUTATE) route, without hitting upstream', async () => {
    const res = await call('/p/small/api/pull', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'llama3' }),
    })
    expect(res.status).toBe(403)
  })

  test('403 for a model not on the allowlist', async () => {
    const res = await call('/p/small/api/chat', chat('llama3:70b'))
    expect(res.status).toBe(403)
  })

  test('200 for an allowed model, streams NDJSON, and meters tokens', async () => {
    const res = await call('/p/small/api/chat', chat('llama3.2:1b'))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('"done":true')
    await drainMeters()
    const dims = Object.fromEntries(sink.events.map((e) => [e.dim, e.value]))
    expect(dims).toEqual({ tokens_in: 11, tokens_out: 22 })
    expect(sink.events[0]).toMatchObject({ orgId: fx.orgId, keyId: fx.keyId, paddockId: fx.paddockId, breedId: 'ollama' })
  })

  test('429 once the fence rate limit (max 5/60s) is exceeded', async () => {
    for (let i = 0; i < 5; i++) {
      const ok = await call('/p/small/api/chat', chat('llama3.2:1b'))
      expect(ok.status).toBe(200)
      await ok.text()
    }
    const limited = await call('/p/small/api/chat', chat('llama3.2:1b'))
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBeTruthy()
    await drainMeters()
  })
})
