import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as schema from '@metamodels/schema'
import { hashApiKey } from '@metamodels/schema'

export type TestDb = ReturnType<typeof drizzle<typeof schema>>

export async function makeDb(): Promise<TestDb> {
  const client = new PGlite()
  const db = drizzle(client, { schema })
  // migrations live in the schema package's drizzle/ dir
  const here = dirname(fileURLToPath(import.meta.url))
  const migrationsFolder = resolve(here, '../../../../packages/schema/drizzle')
  await migrate(db, { migrationsFolder })
  return db
}

export interface Fixture {
  orgId: string; paddockId: string; keyId: string
  keyPlaintext: string; keyHash: string; slug: string
}

export async function seedFixture(db: TestDb): Promise<Fixture> {
  const [org] = await db.insert(schema.org).values({ name: 'default' }).returning()
  const [flock] = await db.insert(schema.flock).values({
    orgId: org.id, breed: 'ollama', name: 'local', baseUrl: 'http://fake.ollama',
  }).returning()
  const [paddock] = await db.insert(schema.paddock).values({
    orgId: org.id, flockId: flock.id, slug: 'small', name: 'Small models',
  }).returning()
  await db.insert(schema.fence).values({
    orgId: org.id, paddockId: paddock.id,
    constraintJson: { allowedRoutes: ['chat', 'generate', 'embed', 'read'], allowedModels: ['llama3.2:1b'] },
    rateLimit: { windowSec: 60, max: 5 }, quota: null,
  })
  const keyPlaintext = 'mm_live_testkey'
  const keyHash = hashApiKey(keyPlaintext)
  const [key] = await db.insert(schema.apiKey).values({
    orgId: org.id, name: 'test', prefix: keyPlaintext.slice(0, 12), hash: keyHash, status: 'active',
  }).returning()
  await db.insert(schema.keyPaddock).values({ keyId: key.id, paddockId: paddock.id })
  return { orgId: org.id, paddockId: paddock.id, keyId: key.id, keyPlaintext, keyHash, slug: 'small' }
}
