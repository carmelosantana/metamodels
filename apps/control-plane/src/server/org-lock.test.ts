import { describe, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import * as schema from '@metamodels/schema'
import { sharedDb, seedOrg } from '../test/db'
import { acquireOrgLock } from './org-lock'

const testDb = sharedDb()

describe('acquireOrgLock', () => {
  test('locks an existing org row inside a transaction without error', async () => {
    const db = testDb()
    const o = await seedOrg(db)
    await db.transaction(async (tx) => {
      await acquireOrgLock(tx, o.id) // must not throw; row exists
      // still usable afterwards
      const rows = await tx.select().from(schema.org).where(sql`${schema.org.id} = ${o.id}`)
      expect(rows.length).toBe(1)
    })
  })

  test('is a no-op-shaped lock for a missing org (no row to lock, no throw)', async () => {
    const db = testDb()
    await db.transaction(async (tx) => {
      await expect(acquireOrgLock(tx, '00000000-0000-0000-0000-000000000000')).resolves.toBeUndefined()
    })
  })
})
