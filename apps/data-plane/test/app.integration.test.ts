import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { buildRegistry } from '../src/breeds.js'
import { DrizzleConfigStore } from '../src/config/config-store.js'
import { InMemoryRateLimiter } from '../src/ratelimit/rate-limiter.js'
import { InMemoryMeterSink } from '../src/meter/meter-sink.js'
import { createFakeOllama } from './helpers/fake-ollama.js'
import { seal, type SealBinding } from '@metamodels/schema/sealed'
import { makeDb, seedFixture, TEST_RING, testRing, type Fixture, type TestDb } from './helpers/seed.js'
import * as schema from '@metamodels/schema'
import { hashApiKey } from '@metamodels/schema'

let db: TestDb
let fx: Fixture
let sink: InMemoryMeterSink
let app: ReturnType<typeof createApp>['app']
let drainMeters: () => Promise<void>

// Refusing a presented key logs its reason by design (`unauthorized.ts`); that belongs in an
// operator's log, not in this run's stderr. The logging itself is asserted in unauthorized.test.ts.
let warn: ReturnType<typeof vi.spyOn>
afterEach(() => { warn.mockRestore() })

beforeEach(async () => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  db = await makeDb()
  fx = await seedFixture(db)
  sink = new InMemoryMeterSink()
  const fake = createFakeOllama()
  const built = createApp({
    configStore: new DrizzleConfigStore(db, TEST_RING),
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

/** An `active` key whose `expires_at` is in the past — the only arm the fixture cannot express. */
async function seedExpiredKey(): Promise<string> {
  const plaintext = `mm_live_expired_${crypto.randomUUID()}`
  const [key] = await db.insert(schema.apiKey).values({
    orgId: fx.orgId, name: 'expired', prefix: plaintext.slice(0, 12), hash: hashApiKey(plaintext),
    status: 'active', expiresAt: new Date(Date.now() - 60_000),
  }).returning()
  await db.insert(schema.keyPaddock).values({ keyId: key!.id, paddockId: fx.paddockId })
  return plaintext
}

describe('data-plane /p/:slug', () => {
  test('401 without a key', async () => {
    const res = await call('/p/small/api/chat', { ...chat('llama3.2:1b') }, '')
    expect(res.status).toBe(401)
  })

  test('401 with an unknown key', async () => {
    const res = await call('/p/small/api/chat', chat('llama3.2:1b'), 'mm_live_wrong')
    expect(res.status).toBe(401)
  })

  // RFC 9110 §15.5.2: WWW-Authenticate is a MUST on every 401. `Bearer` because that is the
  // scheme `extractKey` reads; bare, because an `error=` parameter would regrade the 401s that
  // the test below deliberately flattens.
  test('every 401 from the proxy carries a bare Bearer challenge', async () => {
    const [missing, unknown, expired] = await Promise.all([
      call('/p/small/api/chat', { ...chat('llama3.2:1b') }, ''),
      call('/p/small/api/chat', chat('llama3.2:1b'), 'mm_live_wrong'),
      call('/p/small/api/chat', chat('llama3.2:1b'), await seedExpiredKey()),
    ])
    for (const res of [missing, unknown, expired]) {
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toBe('Bearer')
      expect(res.headers.get('www-authenticate')).not.toContain('error')
    }
  })

  // An expired key is a key that existed; an unknown one never did. Telling them apart over the
  // wire grades a `mm_live_` guess, so both answer identically. A REVOKED key already collapsed
  // into the unknown body (`resolveKeyByHash` returns null for any non-active status) — expiry
  // was the one arm still leaking.
  test('an expired key is byte-identical to an unknown key, end to end', async () => {
    const expiredPlaintext = await seedExpiredKey()
    const [unknown, expired] = await Promise.all([
      call('/p/small/api/chat', chat('llama3.2:1b'), 'mm_live_wrong'),
      call('/p/small/api/chat', chat('llama3.2:1b'), expiredPlaintext),
    ])
    expect(expired.status).toBe(unknown.status)
    const [a, b] = [await unknown.text(), await expired.text()]
    expect(b).toBe(a)
    expect(b).not.toContain('expired')
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

describe('data-plane /p/:slug — the sealed upstream credential', () => {
  async function appWith(sealFor: (bind: SealBinding) => string) {
    const db = await makeDb()
    const f = await seedFixture(db, { sealFor })
    const seen: (string | null)[] = []
    const fake = createFakeOllama()
    const { app } = createApp({
      configStore: new DrizzleConfigStore(db, TEST_RING),
      rateLimiter: new InMemoryRateLimiter(),
      meterSink: new InMemoryMeterSink(),
      registry: buildRegistry(),
      fetchImpl: (url, init) => {
        seen.push(new Headers(init?.headers).get('authorization'))
        return fake.request(url, init)
      },
    })
    const req = (key: string, slug = 'small') => app.request(`http://dp.local/p/${slug}/api/chat`, {
      ...chat('llama3.2:1b'), headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    })
    return { f, seen, req }
  }

  test('sends the opened credential upstream', async () => {
    const { f, seen, req } = await appWith((b) => seal('upstream-tok', TEST_RING, b))
    const res = await req(f.keyPlaintext)
    expect(res.status).toBe(200)
    expect(seen).toEqual(['Bearer upstream-tok'])
  })

  test('fails closed with a 503 when the credential cannot be opened, and never calls upstream', async () => {
    const { f, seen, req } = await appWith((b) => seal('upstream-tok', testRing(), b))
    const res = await req(f.keyPlaintext)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'upstream credential unavailable' })
    expect(seen).toEqual([])
  })

  test('the 503 comes after the key check, so an unauthenticated caller cannot probe for it', async () => {
    const { seen, req } = await appWith((b) => seal('upstream-tok', testRing(), b))
    expect((await req('mm_live_wrong')).status).toBe(401)
    expect(seen).toEqual([])
  })
})
