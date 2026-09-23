import { afterAll, beforeAll, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import { flock, org } from '@metamodels/schema'
import { freshDb, resetDb, seedOrg, type TestDb } from './db'

let db: TestDb
beforeAll(async () => { db = await freshDb() })
afterAll(async () => { await db.$client.close() })

const count = async (table: string) =>
  (await db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from "${table}"`))).rows[0].n

test('resetDb empties every public table and keeps the migrated schema', async () => {
  const o = await seedOrg(db)
  await db.insert(flock).values({ orgId: o.id, breed: 'ollama', name: 'f', baseUrl: 'http://u:11434' })

  await resetDb(db)

  expect(await count('org')).toBe(0)
  expect(await count('flock')).toBe(0)
  // The schema and the migration journal survive, so the next case seeds without migrating again.
  await db.insert(org).values({ name: 'again' })
  expect(await count('org')).toBe(1)
  const { rows } = await db.execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)
  expect(rows[0].n).toBeGreaterThan(0)
})
