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

beforeAll(async () => {
  const client = new PGlite()
  db = drizzle(client, { schema })
  // Apply the real generated Drizzle migrations to the in-memory DB.
  const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../drizzle')
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
})
