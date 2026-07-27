import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { eq } from 'drizzle-orm'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, test } from 'vitest'
import * as schema from '../src/schema.js'

const { apiKey, fence, flock, org, paddock } = schema

let db: ReturnType<typeof drizzle<typeof schema>>

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../drizzle')

async function freshMigratedDb() {
  const client = new PGlite()
  const fresh = drizzle(client, { schema })
  // Apply the real generated Drizzle migrations to a fresh in-memory DB.
  await migrate(fresh, { migrationsFolder })
  return fresh
}

beforeAll(async () => {
  const client = new PGlite()
  db = drizzle(client, { schema })
  // Apply the real generated Drizzle migrations to the in-memory DB.
  await migrate(db, { migrationsFolder })
})

describe('schema', () => {
  test('org → flock → paddock → fence chain inserts and reads back', async () => {
    const [o] = await db.insert(org).values({ name: 'default' }).returning()
    const [f] = await db.insert(flock).values({
      orgId: o.id, breed: 'ollama', name: 'local-ollama',
      baseUrl: 'http://localhost:11434',
    }).returning()
    const [p] = await db.insert(paddock).values({
      orgId: o.id, flockId: f.id, slug: 'small-models', name: 'Small models',
    }).returning()
    const [fc] = await db.insert(fence).values({
      orgId: o.id, paddockId: p.id, constraintJson: { allowedRoutes: ['chat'] },
      rateLimit: { windowSec: 60, max: 30 }, quota: null,
    }).returning()

    expect(f.breed).toBe('ollama')
    expect(p.slug).toBe('small-models')
    expect((fc.constraintJson as { allowedRoutes: string[] }).allowedRoutes).toContain('chat')

    const found = await db.select().from(paddock).where(eq(paddock.slug, 'small-models'))
    expect(found).toHaveLength(1)
  })

  test('apiKey stores hash not plaintext', async () => {
    const [o] = await db.insert(org).values({ name: 'k' }).returning()
    const [k] = await db.insert(apiKey).values({
      orgId: o.id, name: 'test', prefix: 'mm_live_abcd',
      hash: 'a'.repeat(64), status: 'active',
    }).returning()
    expect(k.hash).toHaveLength(64)
    expect((k as Record<string, unknown>).plaintext).toBeUndefined()
  })

  test('usage_rollup rejects a duplicate (org,key,paddock,period,dim) row', async () => {
    const db = await freshMigratedDb()
    const [org] = await db.insert(schema.org).values({ name: 'o' }).returning()
    const [flock] = await db.insert(schema.flock).values({ orgId: org.id, breed: 'ollama', name: 'f', baseUrl: 'http://x' }).returning()
    const [pad] = await db.insert(schema.paddock).values({ orgId: org.id, flockId: flock.id, slug: 's1', name: 'p' }).returning()
    const [key] = await db.insert(schema.apiKey).values({ orgId: org.id, name: 'k', prefix: 'mm_live_x', hash: 'h1' }).returning()
    const row = { orgId: org.id, keyId: key.id, paddockId: pad.id, period: '2026-07-27T14', dim: 'tokens_out', value: 1 }
    await db.insert(schema.usageRollup).values(row)
    await expect(db.insert(schema.usageRollup).values(row)).rejects.toThrow()
  })

  test('job table stores and reads a record', async () => {
    const db = await freshMigratedDb()
    const [org] = await db.insert(schema.org).values({ name: 'o' }).returning()
    const [flock] = await db.insert(schema.flock).values({ orgId: org.id, breed: 'comfyui', name: 'f', baseUrl: 'http://x' }).returning()
    const [pad] = await db.insert(schema.paddock).values({ orgId: org.id, flockId: flock.id, slug: 's2', name: 'p' }).returning()
    const [key] = await db.insert(schema.apiKey).values({ orgId: org.id, name: 'k', prefix: 'mm_live_y', hash: 'h2' }).returning()
    await db.insert(schema.job).values({
      id: 'prompt-1', orgId: org.id, keyId: key.id, paddockId: pad.id,
      templateId: 'tpl-a', cost: 3, submittedAt: new Date(1000),
    })
    const rows = await db.select().from(schema.job).where(eq(schema.job.id, 'prompt-1'))
    expect(rows[0]).toMatchObject({ id: 'prompt-1', templateId: 'tpl-a', cost: 3, metered: false })
  })
})
