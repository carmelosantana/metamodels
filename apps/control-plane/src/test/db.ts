import { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeEach } from 'vitest'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as schema from '@metamodels/schema'

const migrationsFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/schema/drizzle',
)

export type TestDb = ReturnType<typeof drizzle<typeof schema>>

export async function freshDb(): Promise<TestDb> {
  const db = drizzle(new PGlite(), { schema })
  await migrate(db, { migrationsFolder })
  return db
}

/**
 * Empties every table the migrations created, leaving the schema and drizzle's journal in place.
 * A `freshDb()` cold-boots PGlite (initdb inside WASM), which costs seconds of CPU and a few hundred
 * MB it never gives back; a file with many cases builds one in `beforeAll` and resets it here in
 * `beforeEach` (tens of ms) instead.
 */
export async function resetDb(db: TestDb): Promise<void> {
  await db.$client.exec(`DO $$ BEGIN
    EXECUTE (SELECT 'TRUNCATE ' || string_agg(format('%I.%I', schemaname, tablename), ', ')
      || ' RESTART IDENTITY CASCADE' FROM pg_tables WHERE schemaname = 'public');
  END $$`)
}

/**
 * One database for the enclosing file (or `describe`), emptied before each case and closed after
 * the last. Call it once at the top level; each case reads its database from the returned getter.
 *
 * A case that fails, above all by timing out, may still be running against the database: writing
 * rows into the next case, or holding a transaction open that would block every later TRUNCATE.
 * So a failed case's database is abandoned, and the next case builds a fresh one.
 */
export function sharedDb(): () => TestDb {
  let db: TestDb | undefined
  beforeEach(async () => {
    if (db) await resetDb(db)
    else db = await freshDb()
  })
  afterEach(({ task }) => {
    if (task.result?.state !== 'fail' || !db) return
    // Not awaited: closing waits behind a transaction that may never end.
    db.$client.close().catch(() => {})
    db = undefined
  })
  afterAll(async () => { await db?.$client.close() })
  return () => db!
}

export async function seedOrg(db: TestDb, name = 'default') {
  const [o] = await db.insert(schema.org).values({ name }).returning()
  return o
}
