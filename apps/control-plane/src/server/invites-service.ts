import { createHash, randomBytes } from 'node:crypto'
import { and, asc, eq, gt, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { invite, USER_ROLES } from '@metamodels/schema'
import type { Db } from './db'
import { requireCapability, type Actor } from '../auth/authorize'
import { writeAudit } from './audit'
import { NotFoundError, SeatLimitError } from './users-service'
import { countActiveUsers, countPendingInvites } from './seats'

export { NotFoundError, SeatLimitError }

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
    const active = await countActiveUsers(tx, actor.orgId)
    const pending = await countPendingInvites(tx, actor.orgId, nowMs)
    if (active + pending >= seatLimit) throw new SeatLimitError()

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
