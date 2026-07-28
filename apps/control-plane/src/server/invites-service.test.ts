import { describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '@metamodels/schema'
import { freshDb, seedOrg, type TestDb } from '../test/db'
import { inviteUser, listPendingInvites, revokeInvite, hashInviteToken, SeatLimitError, NotFoundError } from './invites-service'
import { ForbiddenError, type Actor } from '../auth/authorize'

const NOW = 1_800_000_000_000

async function seedAdminUser(db: TestDb, orgId: string): Promise<Actor> {
  const [u] = await db.insert(schema.user).values({ orgId, email: 'admin@x.io', passwordHash: 'scrypt$x$y', role: 'admin', status: 'active' }).returning()
  return { id: u.id, orgId, email: u.email, role: 'admin' }
}

describe('invites-service', () => {
  test('inviteUser stores only a token hash and returns the token once (seat available)', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const admin = await seedAdminUser(db, o.id)
    const created = await inviteUser(db, admin, { email: 'teammate@x.io', role: 'member' }, 5, NOW)

    expect(created.email).toBe('teammate@x.io')
    expect(created.role).toBe('member')
    expect(created.token.length).toBeGreaterThan(20)

    const [row] = await db.select().from(schema.invite).where(eq(schema.invite.id, created.id))
    expect(row.tokenHash).toBe(hashInviteToken(created.token))
    expect(row.tokenHash).not.toBe(created.token)      // hash, never plaintext
    expect(JSON.stringify(row)).not.toContain(created.token)
    expect(row.acceptedAt).toBeNull()

    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'user.invite'))
    expect(audits.length).toBe(1)
  })

  test('inviteUser is blocked at the seat limit (base=1, seeded admin fills it)', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const admin = await seedAdminUser(db, o.id)
    // limit=1, one active user → no seat → invite blocked (this is the out-of-the-box 5.7a gate)
    await expect(inviteUser(db, admin, { email: 't@x.io', role: 'member' }, 1, NOW)).rejects.toThrow(SeatLimitError)
  })

  test('a pending invite reserves a seat (second invite blocked at limit=2 with 1 admin + 1 pending)', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const admin = await seedAdminUser(db, o.id)
    await inviteUser(db, admin, { email: 'a@x.io', role: 'member' }, 2, NOW) // used=2 (admin+pending)
    await expect(inviteUser(db, admin, { email: 'b@x.io', role: 'member' }, 2, NOW)).rejects.toThrow(SeatLimitError)
  })

  test('inviteUser requires user.manage and validates role', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const admin = await seedAdminUser(db, o.id)
    const member: Actor = { ...admin, role: 'member' }
    await expect(inviteUser(db, member, { email: 'x@x.io', role: 'member' }, 5, NOW)).rejects.toThrow(ForbiddenError)
    await expect(inviteUser(db, admin, { email: 'x@x.io', role: 'root' }, 5, NOW)).rejects.toThrow()
    await expect(inviteUser(db, admin, { email: 'not-an-email', role: 'member' }, 5, NOW)).rejects.toThrow()
  })

  test('listPendingInvites excludes expired/accepted; revokeInvite frees the seat', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const admin = await seedAdminUser(db, o.id)
    const created = await inviteUser(db, admin, { email: 'p@x.io', role: 'member' }, 5, NOW)
    expect((await listPendingInvites(db, admin, NOW)).map((i) => i.email)).toEqual(['p@x.io'])

    await revokeInvite(db, admin, created.id)
    expect(await listPendingInvites(db, admin, NOW)).toEqual([])
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'invite.revoke'))
    expect(audits.length).toBe(1)

    await expect(revokeInvite(db, admin, created.id)).rejects.toThrow(NotFoundError) // already gone
  })
})
