import { describe, expect, test } from 'vitest'
import * as schema from '@metamodels/schema'
import { freshDb, seedOrg } from '../test/db'

describe('invite table (migration 0004)', () => {
  test('freshDb applies 0004 and invite round-trips', async () => {
    const db = await freshDb() // runs ALL migrations incl. 0004
    const o = await seedOrg(db)
    const [row] = await db.insert(schema.invite).values({
      orgId: o.id, email: 'teammate@x.io', role: 'member',
      tokenHash: 'deadbeef', expiresAt: new Date(Date.now() + 86_400_000),
    }).returning()
    expect(row.id).toBeTruthy()
    expect(row.orgId).toBe(o.id)
    expect(row.email).toBe('teammate@x.io')
    expect(row.role).toBe('member')
    expect(row.acceptedAt).toBeNull()
    expect(row.createdAt).toBeInstanceOf(Date)
  })

  test('token_hash is unique', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const base = { orgId: o.id, email: 'a@x.io', role: 'member', tokenHash: 'dup', expiresAt: new Date(Date.now() + 86_400_000) }
    await db.insert(schema.invite).values(base).returning()
    await expect(db.insert(schema.invite).values({ ...base, email: 'b@x.io' }).returning()).rejects.toThrow()
  })
})
