import { auditLog } from '@metamodels/schema'
import type { Actor } from '../auth/authorize'
import type { Db } from './db'

export interface AuditEntry {
  action: string
  target: string
  detail?: unknown
}

/**
 * The one place an audit row is written. Taking the Actor rather than destructured fields is what
 * keeps `org_id`, `actor` and `changed_by` from ever disagreeing, and makes a missing credential a
 * compile error instead of a silent null.
 */
export async function writeAudit(db: Db, actor: Actor, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    orgId: actor.orgId,
    actor: actor.email,
    action: entry.action,
    target: entry.target,
    detail: (entry.detail ?? null) as never,
    changedBy: actor.credential,
  })
}
