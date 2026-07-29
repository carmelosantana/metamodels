import { and, count, eq, gt, isNull } from 'drizzle-orm'
import { invite, user } from '@metamodels/schema'
import type { Db } from './db'
import { requireCapability, type Actor } from '../auth/authorize'
import { getEntitlement, resolveEntitlementSeats } from './entitlement-service'

/** Free/AGPL tier: one operator seat. Plan 5.7b rewrites getSeatLimit to read the entitlement. */
export const BASE_SEATS = 1

export async function getSeatLimit(db: Db, orgId: string, nowMs: number): Promise<number> {
  const e = await getEntitlement(db, orgId)
  if (!e) return BASE_SEATS
  return resolveEntitlementSeats({ status: e.status, seats: e.seats, graceUntil: e.graceUntil }, nowMs)
}

export async function countActiveUsers(db: Db, orgId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(user)
    .where(and(eq(user.orgId, orgId), eq(user.status, 'active')))
  return row?.n ?? 0
}

export async function countPendingInvites(db: Db, orgId: string, nowMs: number): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(invite)
    .where(and(eq(invite.orgId, orgId), isNull(invite.acceptedAt), gt(invite.expiresAt, new Date(nowMs))))
  return row?.n ?? 0
}

export interface SeatUsage {
  used: number
  limit: number
  free: number
}

export async function seatUsage(db: Db, actor: Actor, limit: number, nowMs: number): Promise<SeatUsage> {
  requireCapability(actor, 'user.manage')
  const [active, pending] = await Promise.all([
    countActiveUsers(db, actor.orgId),
    countPendingInvites(db, actor.orgId, nowMs),
  ])
  const used = active + pending
  return { used, limit, free: Math.max(0, limit - used) }
}
