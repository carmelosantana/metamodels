import { and, desc, eq } from 'drizzle-orm'
import { auditLog } from '@metamodels/schema'
import type { Db } from './db'
import { requireCapability, type Actor } from '../auth/authorize'

export interface AuditRow {
  id: string
  createdAt: Date
  actor: string
  action: string
  target: string
  detail: unknown
}

export async function listAudit(
  db: Db, actor: Actor, opts: { action?: string; auditActor?: string; limit: number },
): Promise<AuditRow[]> {
  requireCapability(actor, 'read')
  const conds = [eq(auditLog.orgId, actor.orgId)]
  if (opts.action) conds.push(eq(auditLog.action, opts.action))
  if (opts.auditActor) conds.push(eq(auditLog.actor, opts.auditActor))

  const rows = await db
    .select({
      id: auditLog.id, createdAt: auditLog.createdAt, actor: auditLog.actor,
      action: auditLog.action, target: auditLog.target, detail: auditLog.detail,
    })
    .from(auditLog)
    .where(and(...conds))
    .orderBy(desc(auditLog.createdAt))
    .limit(opts.limit)
  return rows.map((r) => ({ ...r, detail: r.detail as unknown }))
}

export async function auditFilterOptions(
  db: Db, actor: Actor,
): Promise<{ actions: string[]; actors: string[] }> {
  requireCapability(actor, 'read')
  const rows = await db
    .select({ action: auditLog.action, actor: auditLog.actor })
    .from(auditLog)
    .where(eq(auditLog.orgId, actor.orgId))
  const actions = [...new Set(rows.map((r) => r.action))].sort()
  const actors = [...new Set(rows.map((r) => r.actor))].sort()
  return { actions, actors }
}
