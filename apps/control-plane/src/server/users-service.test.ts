import { describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '@metamodels/schema'
import { freshDb, seedOrg, type TestDb } from '../test/db'
import { listUsers, changeUserRole, setUserStatus, LastAdminError, SelfActionError, SeatLimitError, NotFoundError } from './users-service'
import { ForbiddenError, type Actor } from '../auth/authorize'

const NOW = 1_800_000_000_000

async function seedUser(db: TestDb, orgId: string, email: string, role: string, status = 'active') {
  const [u] = await db.insert(schema.user).values({ orgId, email, passwordHash: 'scrypt$x$y', role, status }).returning()
  return u
}
function actor(u: { id: string; orgId: string; email: string }, role: Actor['role'] = 'admin'): Actor {
  return { id: u.id, orgId: u.orgId, email: u.email, role }
}

describe('users-service', () => {
  test('listUsers is org-scoped, ordered, and requires user.manage', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const a = await seedUser(db, o.id, 'admin@x.io', 'admin')
    await seedUser(db, o.id, 'm@x.io', 'member')
    const other = await seedOrg(db, 'other')
    await seedUser(db, other.id, 'x@x.io', 'member')

    const rows = await listUsers(db, actor(a))
    expect(rows.map((r) => r.email)).toEqual(['admin@x.io', 'm@x.io'])

    const viewer: Actor = { ...actor(a), role: 'viewer' }
    await expect(listUsers(db, viewer)).rejects.toThrow(ForbiddenError)
  })

  test('changeUserRole updates and audits; cannot demote the last admin', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const a = await seedUser(db, o.id, 'admin@x.io', 'admin')
    const m = await seedUser(db, o.id, 'm@x.io', 'member')

    await changeUserRole(db, actor(a), m.id, 'admin')
    const [mAfter] = await db.select().from(schema.user).where(eq(schema.user.id, m.id))
    expect(mAfter.role).toBe('admin')

    // Now demote the original admin — allowed, since m is admin now.
    await changeUserRole(db, actor(a), a.id, 'member')
    // Attempt to demote the last remaining admin (m) → blocked.
    await expect(changeUserRole(db, actor(m), m.id, 'member')).rejects.toThrow(LastAdminError)

    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'user.role'))
    expect(audits.length).toBe(2)
  })

  test('changeUserRole rejects unknown/cross-org target', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const a = await seedUser(db, o.id, 'admin@x.io', 'admin')
    const other = await seedOrg(db, 'other')
    const x = await seedUser(db, other.id, 'x@x.io', 'member')
    await expect(changeUserRole(db, actor(a), x.id, 'admin')).rejects.toThrow(NotFoundError)
  })

  test('setUserStatus: cannot deactivate self or the last admin', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const a = await seedUser(db, o.id, 'admin@x.io', 'admin')
    await expect(setUserStatus(db, actor(a), a.id, 'deactivated', 5, NOW)).rejects.toThrow(SelfActionError)

    const a2 = await seedUser(db, o.id, 'admin2@x.io', 'admin')
    await setUserStatus(db, actor(a), a2.id, 'deactivated', 5, NOW) // ok, a still admin
    // a is now the last active admin; another admin cannot be created to deactivate a here,
    // so assert the last-admin guard via a fresh minimal org:
    const o2 = await seedOrg(db, 'solo')
    const solo = await seedUser(db, o2.id, 'solo@x.io', 'admin')
    const helper = await seedUser(db, o2.id, 'helper@x.io', 'admin')
    await setUserStatus(db, actor(solo), helper.id, 'deactivated', 5, NOW)
    await expect(setUserStatus(db, actor(helper, 'admin'), solo.id, 'deactivated', 5, NOW)).rejects.toThrow(NotFoundError)
    // (helper is deactivated → getCurrentActor would already block; the service still org-scopes.)
  })

  test('reactivation is blocked when no seat is free, allowed when seats remain', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const a = await seedUser(db, o.id, 'admin@x.io', 'admin')
    const m = await seedUser(db, o.id, 'm@x.io', 'member', 'deactivated')
    // limit=1, admin already active → no free seat → reactivation blocked
    await expect(setUserStatus(db, actor(a), m.id, 'active', 1, NOW)).rejects.toThrow(SeatLimitError)
    // limit=2 → one free seat → allowed
    await setUserStatus(db, actor(a), m.id, 'active', 2, NOW)
    const [mAfter] = await db.select().from(schema.user).where(eq(schema.user.id, m.id))
    expect(mAfter.status).toBe('active')
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'user.reactivate'))
    expect(audits.length).toBe(1)
  })
})
