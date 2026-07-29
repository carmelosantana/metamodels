import { and, asc, eq, ne } from 'drizzle-orm'
import { user } from '@metamodels/schema'
import type { Db } from './db'
import { requireCapability, type Actor, type Role } from '../auth/authorize'
import { writeAudit } from './audit'
import { NotFoundError } from './flocks-service'
import { countActiveUsers, countPendingInvites } from './seats'
import { acquireOrgLock } from './org-lock'

export { NotFoundError }

export class LastAdminError extends Error {
  constructor() {
    super('cannot remove the last active admin')
    this.name = 'LastAdminError'
  }
}
export class SelfActionError extends Error {
  constructor() {
    super('you cannot deactivate your own account')
    this.name = 'SelfActionError'
  }
}
export class SeatLimitError extends Error {
  constructor() {
    super('seat limit reached — upgrade, revoke a pending invite, or deactivate a user')
    this.name = 'SeatLimitError'
  }
}

export interface UserRow {
  id: string
  email: string
  role: string
  status: string
  createdAt: Date
}

export async function listUsers(db: Db, actor: Actor): Promise<UserRow[]> {
  requireCapability(actor, 'user.manage')
  return db
    .select({ id: user.id, email: user.email, role: user.role, status: user.status, createdAt: user.createdAt })
    .from(user)
    .where(eq(user.orgId, actor.orgId))
    .orderBy(asc(user.createdAt))
}

/** Count OTHER active admins in the org (excludes `exceptId`). Used for the last-admin guard. */
async function otherActiveAdmins(db: Db, orgId: string, exceptId: string): Promise<number> {
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.orgId, orgId), eq(user.role, 'admin'), eq(user.status, 'active'), ne(user.id, exceptId)))
  return rows.length
}

export async function changeUserRole(db: Db, actor: Actor, userId: string, role: Role): Promise<void> {
  requireCapability(actor, 'user.manage')
  await db.transaction(async (tx) => {
    await acquireOrgLock(tx, actor.orgId)
    const [target] = await tx.select().from(user).where(and(eq(user.id, userId), eq(user.orgId, actor.orgId)))
    if (!target) throw new NotFoundError(`user ${userId}`)
    // Demoting the last active admin away from 'admin' would strand the org with no admin.
    if (target.role === 'admin' && role !== 'admin' && target.status === 'active') {
      if ((await otherActiveAdmins(tx, actor.orgId, userId)) === 0) throw new LastAdminError()
    }
    await tx.update(user).set({ role }).where(and(eq(user.id, userId), eq(user.orgId, actor.orgId)))
    await writeAudit(tx, {
      orgId: actor.orgId, actor: actor.email, action: 'user.role',
      target: `user:${userId}`, detail: { role },
    })
  })
}

export async function setUserStatus(
  db: Db, actor: Actor, userId: string, status: 'active' | 'deactivated', seatLimit: number, nowMs: number,
): Promise<void> {
  requireCapability(actor, 'user.manage')
  if (status === 'deactivated' && userId === actor.id) throw new SelfActionError()
  await db.transaction(async (tx) => {
    await acquireOrgLock(tx, actor.orgId)
    // Actor standing: only an ACTIVE member of the org may manage user status. A deactivated
    // acting user has no standing, so the target is not found from their context. (In production
    // getCurrentActor blocks deactivated users at auth; this is defense-in-depth within the tx.)
    const [self] = await tx
      .select({ status: user.status })
      .from(user)
      .where(and(eq(user.id, actor.id), eq(user.orgId, actor.orgId)))
    if (!self || self.status !== 'active') throw new NotFoundError(`user ${userId}`)
    const [target] = await tx.select().from(user).where(and(eq(user.id, userId), eq(user.orgId, actor.orgId)))
    if (!target) throw new NotFoundError(`user ${userId}`)
    if (status === 'deactivated' && target.role === 'admin' && target.status === 'active') {
      if ((await otherActiveAdmins(tx, actor.orgId, userId)) === 0) throw new LastAdminError()
    }
    if (status === 'active' && target.status !== 'active') {
      // Reactivating consumes a seat — enforce the invariant.
      const active = await countActiveUsers(tx, actor.orgId)
      const pending = await countPendingInvites(tx, actor.orgId, nowMs)
      if (active + pending >= seatLimit) throw new SeatLimitError()
    }
    await tx.update(user).set({ status }).where(and(eq(user.id, userId), eq(user.orgId, actor.orgId)))
    await writeAudit(tx, {
      orgId: actor.orgId, actor: actor.email,
      action: status === 'active' ? 'user.reactivate' : 'user.deactivate',
      target: `user:${userId}`,
    })
  })
}
