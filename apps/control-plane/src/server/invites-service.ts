import { createHash, randomBytes } from 'node:crypto'
import { and, asc, eq, gt, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { invite, user, USER_ROLES } from '@metamodels/schema'
import type { Db } from './db'
import { isRole, requireCapability, type Actor, type Role } from '../auth/authorize'
import { hashPassword } from '../auth/password'
import { writeAudit } from './audit'
import { NotFoundError, SeatLimitError } from './users-service'
import { countActiveUsers, countPendingInvites } from './seats'
import { acquireOrgLock } from './org-lock'

export { NotFoundError, SeatLimitError }

export class DuplicateInviteError extends Error {
  constructor(email: string) {
    super(`already invited or a member: ${email}`)
    this.name = 'DuplicateInviteError'
  }
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

const inviteInput = z.object({
  email: z.string().email().transform((s) => s.trim().toLowerCase()),
  role: z.enum(USER_ROLES),
})

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export interface PendingInvite {
  id: string
  email: string
  role: string
  expiresAt: Date
  createdAt: Date
}

export interface CreatedInvite {
  id: string
  email: string
  role: string
  /** The invite token — surfaced exactly once (build the /accept-invite link from it). Never stored. */
  token: string
}

export async function inviteUser(
  db: Db, actor: Actor, input: unknown, seatLimit: number, nowMs: number,
): Promise<CreatedInvite> {
  requireCapability(actor, 'user.manage')
  const data = inviteInput.parse(input)
  const token = randomBytes(24).toString('base64url')
  const tokenHash = hashInviteToken(token)

  return db.transaction(async (tx) => {
    await acquireOrgLock(tx, actor.orgId)
    const active = await countActiveUsers(tx, actor.orgId)
    const pending = await countPendingInvites(tx, actor.orgId, nowMs)
    if (active + pending >= seatLimit) throw new SeatLimitError()

    const existingUser = await tx.select({ id: user.id }).from(user)
      .where(and(eq(user.orgId, actor.orgId), eq(user.email, data.email), eq(user.status, 'active'))).limit(1)
    const existingInvite = await tx.select({ id: invite.id }).from(invite)
      .where(and(eq(invite.orgId, actor.orgId), eq(invite.email, data.email), isNull(invite.acceptedAt), gt(invite.expiresAt, new Date(nowMs)))).limit(1)
    if (existingUser.length || existingInvite.length) throw new DuplicateInviteError(data.email)

    const [row] = await tx.insert(invite).values({
      orgId: actor.orgId,
      email: data.email,
      role: data.role,
      tokenHash,
      expiresAt: new Date(nowMs + INVITE_TTL_MS),
    }).returning()

    await writeAudit(tx, {
      orgId: actor.orgId, actor: actor.email, action: 'user.invite',
      target: `invite:${row.id}`, detail: { email: data.email, role: data.role },
    })

    return { id: row.id, email: row.email, role: row.role, token }
  })
}

export async function listPendingInvites(db: Db, actor: Actor, nowMs: number): Promise<PendingInvite[]> {
  requireCapability(actor, 'user.manage')
  return db
    .select({ id: invite.id, email: invite.email, role: invite.role, expiresAt: invite.expiresAt, createdAt: invite.createdAt })
    .from(invite)
    .where(and(eq(invite.orgId, actor.orgId), isNull(invite.acceptedAt), gt(invite.expiresAt, new Date(nowMs))))
    .orderBy(asc(invite.createdAt))
}

export async function revokeInvite(db: Db, actor: Actor, id: string): Promise<void> {
  requireCapability(actor, 'user.manage')
  await db.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(invite)
      .where(and(eq(invite.id, id), eq(invite.orgId, actor.orgId), isNull(invite.acceptedAt)))
      .returning()
    if (!deleted) throw new NotFoundError(`invite ${id}`)
    await writeAudit(tx, {
      orgId: actor.orgId, actor: actor.email, action: 'invite.revoke', target: `invite:${id}`,
    })
  })
}

export class InviteError extends Error {
  readonly reason: 'invalid' | 'expired' | 'accepted'
  constructor(reason: 'invalid' | 'expired' | 'accepted') {
    super(`invite ${reason}`)
    this.name = 'InviteError'
    this.reason = reason
  }
}

const MIN_PASSWORD_LEN = 8

export async function acceptInvite(db: Db, token: string, password: string, nowMs: number): Promise<Actor> {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN) {
    throw new Error(`password must be at least ${MIN_PASSWORD_LEN} characters`)
  }
  const tokenHash = hashInviteToken(token)
  const [inv] = await db.select().from(invite).where(eq(invite.tokenHash, tokenHash)).limit(1)
  if (!inv) throw new InviteError('invalid')
  if (inv.acceptedAt) throw new InviteError('accepted')
  if (inv.expiresAt.getTime() <= nowMs) throw new InviteError('expired')
  const role: Role = isRole(inv.role) ? inv.role : 'viewer'
  const passwordHash = await hashPassword(password)

  return db.transaction(async (tx) => {
    // Re-check acceptance inside the tx so two concurrent accepts of the same token can't both win.
    const [locked] = await tx.select().from(invite).where(and(eq(invite.id, inv.id), isNull(invite.acceptedAt)))
    if (!locked) throw new InviteError('accepted')

    const [u] = await tx.insert(user).values({
      orgId: inv.orgId, email: inv.email, passwordHash, role, status: 'active',
    }).returning()

    await tx.update(invite).set({ acceptedAt: new Date(nowMs) }).where(eq(invite.id, inv.id))

    await writeAudit(tx, {
      orgId: inv.orgId, actor: u.email, action: 'user.accept',
      target: `user:${u.id}`, detail: { role, invite: inv.id },
    })

    return { id: u.id, orgId: u.orgId, email: u.email, role }
  })
}
