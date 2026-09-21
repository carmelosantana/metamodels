import { eq } from 'drizzle-orm'
import { user } from '@metamodels/schema'
import { isRole, type Actor } from '../auth/authorize'
import type { Db } from './db'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The Actor for an active user, or null. The single place a user row becomes an Actor — used on
 * every request (session cookie) and at sign-in (ID-token subject), so deactivation or a role
 * change takes effect immediately on both paths.
 */
export async function loadActiveActor(db: Db, uid: string): Promise<Actor | null> {
  if (!UUID.test(uid)) return null
  const rows = await db.select().from(user).where(eq(user.id, uid)).limit(1)
  const u = rows[0]
  if (!u || u.status !== 'active' || !isRole(u.role)) return null
  return { id: u.id, orgId: u.orgId, email: u.email, role: u.role }
}
