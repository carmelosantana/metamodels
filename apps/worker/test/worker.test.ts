import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import Redis from 'ioredis'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as schema from '@metamodels/schema'
import { encodeMeterEvent, METER_STREAM_KEY } from '@metamodels/schema'
import { ensureGroup, processOnce } from '../src/worker.js'

// ioredis-mock@8.9.0 does NOT support consumer-group commands (XGROUP/XREADGROUP/XACK):
// `new RedisMock().xgroup(...)` throws "Unsupported command: xgroup". So this suite —
// which exists only to prove the read→apply→ack WIRING — runs against a real Redis when
// REDIS_TEST_URL is set, and is skipped otherwise. Aggregation correctness is already
// fully covered by aggregator.test.ts on pglite.
const REDIS_URL = process.env.REDIS_TEST_URL

async function freshDb() {
  const db = drizzle(new PGlite(), { schema })
  const here = dirname(fileURLToPath(import.meta.url))
  await migrate(db, { migrationsFolder: resolve(here, '../../../packages/schema/drizzle') })
  return db
}
async function scope(db: Awaited<ReturnType<typeof freshDb>>) {
  const [org] = await db.insert(schema.org).values({ name: 'o' }).returning()
  const [flock] = await db.insert(schema.flock).values({ orgId: org.id, breed: 'ollama', name: 'f', baseUrl: 'http://x' }).returning()
  const [pad] = await db.insert(schema.paddock).values({ orgId: org.id, flockId: flock.id, slug: 's', name: 'p' }).returning()
  const [key] = await db.insert(schema.apiKey).values({ orgId: org.id, name: 'k', prefix: 'mm_live_w', hash: 'h' }).returning()
  return { orgId: org.id, keyId: key.id, paddockId: pad.id }
}

describe.skipIf(!REDIS_URL)('processOnce', () => {
  // One shared connection; isolate every test by deleting the stream key (which also
  // drops its consumer-group state) so entries never leak between tests. The client is
  // constructed in beforeAll (not the describe body) so that when the suite is skipped no
  // Redis socket is ever opened — Vitest still evaluates a skipped describe factory.
  let redis: Redis
  beforeAll(() => {
    redis = new Redis(REDIS_URL!, { maxRetriesPerRequest: null })
  })
  beforeEach(async () => {
    await redis.del(METER_STREAM_KEY)
  })
  afterAll(async () => {
    await redis.del(METER_STREAM_KEY)
    await redis.quit()
  })

  test('reads pending stream entries, upserts rollups, and returns the count', async () => {
    const db = await freshDb(); const s = await scope(db)
    await ensureGroup(redis)
    const at = Date.UTC(2026, 6, 27, 14)
    const { data } = encodeMeterEvent({ ...s, breedId: 'ollama', dim: 'tokens_out', value: 8, at })
    await redis.xadd(METER_STREAM_KEY, '*', 'data', data)

    const n = await processOnce(redis, db, 'c1')
    expect(n).toBe(1)
    const rows = await db.select().from(schema.usageRollup)
    expect(rows[0]).toMatchObject({ period: '2026-07-27T14', dim: 'tokens_out', value: 8 })
  })

  test('returns 0 when there is nothing pending', async () => {
    const db = await freshDb(); await scope(db)
    await ensureGroup(redis)
    expect(await processOnce(redis, db, 'c1')).toBe(0)
  })

  test('acked entries are not reprocessed on the next pass (no double count)', async () => {
    const db = await freshDb(); const s = await scope(db)
    await ensureGroup(redis)
    const at = Date.UTC(2026, 6, 27, 14)
    const { data } = encodeMeterEvent({ ...s, breedId: 'ollama', dim: 'jobs', value: 1, at })
    await redis.xadd(METER_STREAM_KEY, '*', 'data', data)
    await processOnce(redis, db, 'c1')
    await processOnce(redis, db, 'c1') // second pass: nothing new
    const rows = await db.select().from(schema.usageRollup)
    expect(rows).toHaveLength(1)
    expect(rows[0].value).toBe(1)
  })
})
