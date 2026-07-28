import { PGlite } from '@electric-sql/pglite'
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

export async function seedOrg(db: TestDb, name = 'default') {
  const [o] = await db.insert(schema.org).values({ name }).returning()
  return o
}
