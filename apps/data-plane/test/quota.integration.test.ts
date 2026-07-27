import { describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import { createApp } from '../src/app.js'
import { buildRegistry } from '../src/breeds.js'
import { DrizzleConfigStore } from '../src/config/config-store.js'
import { InMemoryRateLimiter } from '../src/ratelimit/rate-limiter.js'
import { InMemoryMeterSink } from '../src/meter/meter-sink.js'
import { InMemoryJobStore } from '../src/jobs/job-store.js'
import { DrizzleUsageReader } from '../src/meter/usage-reader.js'
import { createFakeOllama } from './helpers/fake-ollama.js'
import { makeDb, seedFixture } from './helpers/seed.js'
import * as schema from '@metamodels/schema'
import { periodBucket } from '@metamodels/schema'

async function appWithQuota(quota: unknown) {
  const db = await makeDb()
  const fx = await seedFixture(db)
  // attach a quota to the seeded fence
  await db.update(schema.fence).set({ quota }).where(eq(schema.fence.paddockId, fx.paddockId))
  const fake = createFakeOllama()
  const { app, drainMeters } = createApp({
    configStore: new DrizzleConfigStore(db),
    rateLimiter: new InMemoryRateLimiter(),
    meterSink: new InMemoryMeterSink(),
    registry: buildRegistry(),
    jobStore: new InMemoryJobStore(),
    usageReader: new DrizzleUsageReader(db),
    fetchImpl: (url, init) => fake.request(url, init), // fake upstream so an allowed request can succeed
  })
  return { app, drainMeters, db, fx }
}

const chatBody = JSON.stringify({ model: 'llama3.2:1b', messages: [{ role: 'user', content: 'hi' }] })

describe('quota enforcement', () => {
  test('a request at/over the period cap is rejected 429 quota exceeded', async () => {
    const { app, db, fx } = await appWithQuota([{ dim: 'tokens_out', max: 10, period: 'hour' }])
    // pre-seed usage at the cap for the current hour
    await db.insert(schema.usageRollup).values({
      orgId: fx.orgId, keyId: fx.keyId, paddockId: fx.paddockId,
      period: periodBucket(Date.now()), dim: 'tokens_out', value: 10,
    })
    const res = await app.request(`/p/${fx.slug}/api/chat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fx.keyPlaintext}`, 'content-type': 'application/json' },
      body: chatBody,
    })
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ error: 'quota exceeded', dim: 'tokens_out' })
  })

  test('a request under the cap passes the quota gate', async () => {
    const { app, fx } = await appWithQuota([{ dim: 'tokens_out', max: 1000, period: 'hour' }])
    const res = await app.request(`/p/${fx.slug}/api/chat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fx.keyPlaintext}`, 'content-type': 'application/json' },
      body: chatBody,
    })
    expect(res.status).toBe(200)
  })

  test('no quota on the fence → gate is skipped', async () => {
    const { app, fx } = await appWithQuota(null)
    const res = await app.request(`/p/${fx.slug}/api/chat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fx.keyPlaintext}`, 'content-type': 'application/json' },
      body: chatBody,
    })
    expect(res.status).toBe(200)
  })
})
