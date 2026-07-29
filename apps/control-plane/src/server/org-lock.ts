import { sql } from 'drizzle-orm'
import type { Db } from './db'

/**
 * Take a per-org row lock inside the current transaction so concurrent seat-consuming /
 * admin-count mutations serialize per org. MUST be the first statement in any transaction
 * that reads a seat or active-admin count and then mutates — otherwise two concurrent
 * requests can each read a stale count and both proceed (over-provision seats, or strand an
 * org with zero admins). Locking a missing org row is a harmless no-op.
 */
export async function acquireOrgLock(tx: Db, orgId: string): Promise<void> {
  await tx.execute(sql`SELECT id FROM "org" WHERE id = ${orgId} FOR UPDATE`)
}
