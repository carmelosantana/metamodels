import { describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '@metamodels/schema'
import { freshDb, seedOrg, type TestDb } from '../test/db'
import { inviteUser, listPendingInvites, revokeInvite, hashInviteToken, SeatLimitError, NotFoundError } from './invites-service'
import { acceptInvite, InviteError } from './invites-service'
import { verifyPassword } from '../auth/password'
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

describe('invites-service acceptInvite', () => {
  test('accepts a valid invite: creates an active user with the invited role + hashed password, marks accepted', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const admin = await seedAdminUser(db, o.id)
    const created = await inviteUser(db, admin, { email: 'new@x.io', role: 'member' }, 5, NOW)

    const actor = await acceptInvite(db, created.token, 'hunter2pass', NOW + 1000)
    expect(actor.email).toBe('new@x.io')
    expect(actor.role).toBe('member')
    expect(actor.orgId).toBe(o.id)

    const [u] = await db.select().from(schema.user).where(eq(schema.user.email, 'new@x.io'))
    expect(u.status).toBe('active')
    expect(u.role).toBe('member')
    expect(await verifyPassword('hunter2pass', u.passwordHash)).toBe(true)
    expect(u.passwordHash).not.toContain('hunter2pass')

    const [inv] = await db.select().from(schema.invite).where(eq(schema.invite.id, created.id))
    expect(inv.acceptedAt).not.toBeNull()

    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'user.accept'))
    expect(audits.length).toBe(1)
  })

  test('rejects invalid, expired, and already-accepted tokens', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const admin = await seedAdminUser(db, o.id)

    await expect(acceptInvite(db, 'not-a-real-token', 'pw12345678', NOW)).rejects.toThrow(InviteError)

    const created = await inviteUser(db, admin, { email: 'e@x.io', role: 'member' }, 5, NOW)
    // expired: nowMs beyond the 7-day TTL
    await expect(acceptInvite(db, created.token, 'pw12345678', NOW + 8 * 24 * 60 * 60 * 1000)).rejects.toThrow(InviteError)

    const good = await inviteUser(db, admin, { email: 'g@x.io', role: 'member' }, 5, NOW)
    await acceptInvite(db, good.token, 'pw12345678', NOW + 1000)
    // second accept of the same token → already accepted
    await expect(acceptInvite(db, good.token, 'pw12345678', NOW + 2000)).rejects.toThrow(InviteError)
  })

  test('rejects a too-short password before creating anything', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const admin = await seedAdminUser(db, o.id)
    const created = await inviteUser(db, admin, { email: 'p@x.io', role: 'member' }, 5, NOW)
    await expect(acceptInvite(db, created.token, 'short', NOW + 1000)).rejects.toThrow()
    const users = await db.select().from(schema.user).where(eq(schema.user.email, 'p@x.io'))
    expect(users.length).toBe(0) // nothing created
  })
})

import { DuplicateInviteError } from './invites-service'

describe('inviteUser duplicate guard', () => {
  test('rejects an email that already has a pending invite', async () => {
    const db = await freshDb(); const o = await seedOrg(db)
    const adminA = await seedAdminUser(db, o.id)
    await inviteUser(db, adminA, { email: 'dup@x.io', role: 'member' }, 5, NOW)
    await expect(inviteUser(db, adminA, { email: 'dup@x.io', role: 'member' }, 5, NOW)).rejects.toThrow(DuplicateInviteError)
  })

  test('rejects an email that already belongs to an active user', async () => {
    const db = await freshDb(); const o = await seedOrg(db)
    const adminA = await seedAdminUser(db, o.id)
    await db.insert(schema.user).values({ orgId: o.id, email: 'taken@x.io', passwordHash: 'scrypt$x$y', role: 'member', status: 'active' })
    await expect(inviteUser(db, adminA, { email: 'taken@x.io', role: 'member' }, 5, NOW)).rejects.toThrow(DuplicateInviteError)
  })
})
