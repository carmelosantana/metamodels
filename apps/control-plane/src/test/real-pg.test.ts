import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import { org } from '@metamodels/schema'
import { PG_TEST_URL, makeRealPgDb, uniqueName } from './real-pg'
import type { Db } from '../server/db'

describe.skipIf(!PG_TEST_URL)('real-pg harness', () => {
  let db: Db
  let close: () => Promise<void>
  beforeAll(async () => {
    ;({ db, close } = await makeRealPgDb())
  })
  afterAll(async () => {
    await close()
  })

  test('migrates and round-trips an org on a real Postgres', async () => {
    const name = uniqueName()
    const [row] = await db.insert(org).values({ name }).returning()
    const [read] = await db.select().from(org).where(eq(org.id, row.id))
    expect(read.name).toBe(name)
  })
})
