import { describe, expect, test } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { and, eq } from 'drizzle-orm'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as schema from '@metamodels/schema'
import { applyEvents, type RollupEvent } from '../src/aggregator.js'

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
  const [key] = await db.insert(schema.apiKey).values({ orgId: org.id, name: 'k', prefix: 'mm_live_z', hash: 'h' }).returning()
  return { orgId: org.id, keyId: key.id, paddockId: pad.id }
}

const AT = Date.UTC(2026, 6, 27, 14, 30) // 2026-07-27T14

describe('applyEvents', () => {
  test('inserts a new rollup row for a fresh bucket', async () => {
    const db = await freshDb(); const s = await scope(db)
    await applyEvents(db, [{ ...s, dim: 'tokens_out', value: 7, at: AT }])
    const rows = await db.select().from(schema.usageRollup)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ period: '2026-07-27T14', dim: 'tokens_out', value: 7 })
  })

  test('accumulates value into the same bucket', async () => {
    const db = await freshDb(); const s = await scope(db)
    const e: RollupEvent = { ...s, dim: 'tokens_out', value: 4, at: AT }
    await applyEvents(db, [e])
    await applyEvents(db, [{ ...e, value: 6 }])
    const rows = await db.select().from(schema.usageRollup)
      .where(and(eq(schema.usageRollup.keyId, s.keyId), eq(schema.usageRollup.dim, 'tokens_out')))
    expect(rows).toHaveLength(1)
    expect(rows[0].value).toBe(10)
  })

  test('separate dims and hour buckets are distinct rows', async () => {
    const db = await freshDb(); const s = await scope(db)
    await applyEvents(db, [
      { ...s, dim: 'tokens_out', value: 1, at: AT },
      { ...s, dim: 'tokens_in', value: 2, at: AT },
      { ...s, dim: 'tokens_out', value: 3, at: AT + 3_600_000 }, // next hour
    ])
    const rows = await db.select().from(schema.usageRollup)
    expect(rows).toHaveLength(3)
  })
})
