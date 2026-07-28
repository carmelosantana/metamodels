import { describe, expect, test } from 'vitest'
import * as schema from '@metamodels/schema'
import { freshDb, seedOrg, type TestDb } from '../test/db'
import { BASE_SEATS, getSeatLimit, countActiveUsers, countPendingInvites, seatUsage } from './seats'
import { ForbiddenError, type Actor } from '../auth/authorize'

const NOW = 1_800_000_000_000

async function admin(db: TestDb, orgId: string): Promise<Actor> {
  return { id: 'admin', orgId, email: 'admin@x.io', role: 'admin' }
}
async function addUser(db: TestDb, orgId: string, email: string, status: 'active' | 'deactivated') {
  await db.insert(schema.user).values({ orgId, email, passwordHash: 'scrypt$x$y', role: 'member', status }).returning()
}
async function addInvite(db: TestDb, orgId: string, email: string, expiresAt: Date, acceptedAt: Date | null) {
  await db.insert(schema.invite).values({ orgId, email, role: 'member', tokenHash: email, expiresAt, acceptedAt }).returning()
}

describe('seats', () => {
  test('getSeatLimit is BASE_SEATS (1) in 5.7a', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    expect(BASE_SEATS).toBe(1)
    expect(await getSeatLimit(db, o.id)).toBe(1)
  })

  test('countActiveUsers ignores deactivated and other orgs', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const other = await seedOrg(db, 'other')
    await addUser(db, o.id, 'a@x.io', 'active')
    await addUser(db, o.id, 'b@x.io', 'deactivated')
    await addUser(db, other.id, 'c@x.io', 'active')
    expect(await countActiveUsers(db, o.id)).toBe(1)
  })

  test('countPendingInvites counts only un-accepted, un-expired, same-org invites', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    await addInvite(db, o.id, 'pending@x.io', new Date(NOW + 1000), null)      // pending
    await addInvite(db, o.id, 'expired@x.io', new Date(NOW - 1000), null)      // expired → not counted
    await addInvite(db, o.id, 'accepted@x.io', new Date(NOW + 1000), new Date(NOW)) // accepted → not counted
    expect(await countPendingInvites(db, o.id, NOW)).toBe(1)
  })

  test('seatUsage sums active + pending against the limit', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    await addUser(db, o.id, 'a@x.io', 'active')
    await addInvite(db, o.id, 'p@x.io', new Date(NOW + 1000), null)
    const usage = await seatUsage(db, await admin(db, o.id), 5, NOW)
    expect(usage).toEqual({ used: 2, limit: 5, free: 3 })
  })

  test('seatUsage requires user.manage', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const viewer: Actor = { id: 'v', orgId: o.id, email: 'v@x.io', role: 'viewer' }
    await expect(seatUsage(db, viewer, 1, NOW)).rejects.toThrow(ForbiddenError)
  })
})
