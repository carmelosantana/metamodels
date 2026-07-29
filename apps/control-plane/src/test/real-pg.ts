import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import * as schema from '@metamodels/schema'
import type { Db } from '../server/db'

/** Set to a REAL multi-connection Postgres to run the integration tests; unset → they skip.
 *  pglite is single-connection and cannot prove SELECT … FOR UPDATE serialization. */
export const PG_TEST_URL = process.env.PG_TEST_URL

const migrationsFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/schema/drizzle',
)

/** Open a real postgres-js drizzle handle (multi-connection) and apply the frozen migrations.
 *  `max: 8` lets two transactions run on distinct connections so a FOR UPDATE lock can actually block. */
export async function makeRealPgDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = postgres(PG_TEST_URL!, { max: 8 })
  const db = drizzle(client, { schema }) as unknown as Db
  await migrate(db as never, { migrationsFolder })
  return { db, close: () => client.end() }
}

export function uniqueEmail(prefix = 'u'): string {
  return `${prefix}-${randomUUID()}@example.com`
}

export function uniqueName(prefix = 'o'): string {
  return `${prefix}-${randomUUID()}`
}
