import { auditLog } from '@metamodels/schema'
import type { Db } from './db'

export interface AuditEntry {
  orgId: string
  actor: string
  action: string
  target: string
  detail?: unknown
}

export async function writeAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    orgId: entry.orgId,
    actor: entry.actor,
    action: entry.action,
    target: entry.target,
    detail: (entry.detail ?? null) as never,
  })
}
