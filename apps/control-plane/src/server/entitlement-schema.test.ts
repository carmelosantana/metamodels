import { describe, expect, test } from 'vitest'
import * as schema from '@metamodels/schema'
import { freshDb, seedOrg } from '../test/db'

describe('entitlement table (migration 0005)', () => {
  test('freshDb applies 0005 and entitlement round-trips; org_id is unique', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const [row] = await db.insert(schema.entitlement).values({
      orgId: o.id, licenseKeyEnc: 'iv:tag:ct', licenseLast4: 'AB12', status: 'active', seats: 5, tier: 'team',
    }).returning()
    expect(row.orgId).toBe(o.id)
    expect(row.seats).toBe(5)
    expect(row.instanceId).toBeNull()
    expect(row.lastValidatedAt).toBeNull()
    // one entitlement per org
    await expect(db.insert(schema.entitlement).values({
      orgId: o.id, licenseKeyEnc: 'x', licenseLast4: 'CD34', status: 'active',
    }).returning()).rejects.toThrow()
  })
})
