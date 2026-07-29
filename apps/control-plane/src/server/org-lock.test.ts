import { describe, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import * as schema from '@metamodels/schema'
import { freshDb, seedOrg } from '../test/db'
import { acquireOrgLock } from './org-lock'

describe('acquireOrgLock', () => {
  test('locks an existing org row inside a transaction without error', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    await db.transaction(async (tx) => {
      await acquireOrgLock(tx, o.id) // must not throw; row exists
      // still usable afterwards
      const rows = await tx.select().from(schema.org).where(sql`${schema.org.id} = ${o.id}`)
      expect(rows.length).toBe(1)
    })
  })

  test('is a no-op-shaped lock for a missing org (no row to lock, no throw)', async () => {
    const db = await freshDb()
    await db.transaction(async (tx) => {
      await expect(acquireOrgLock(tx, '00000000-0000-0000-0000-000000000000')).resolves.toBeUndefined()
    })
  })
})
