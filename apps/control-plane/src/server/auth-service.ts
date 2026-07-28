import { eq } from 'drizzle-orm'
import { user } from '@metamodels/schema'
import type { Db } from './db'
import { isRole, type Actor } from '../auth/authorize'
import { verifyPassword } from '../auth/password'

export type LoginResult =
  | { ok: true; actor: Actor }
  | { ok: false; reason: 'invalid' | 'deactivated' }

export async function verifyLogin(db: Db, email: string, password: string): Promise<LoginResult> {
  const rows = await db.select().from(user).where(eq(user.email, email)).limit(1)
  const u = rows[0]
  if (!u) return { ok: false, reason: 'invalid' }
  const passwordOk = await verifyPassword(password, u.passwordHash)
  if (!passwordOk) return { ok: false, reason: 'invalid' }
  if (u.status !== 'active') return { ok: false, reason: 'deactivated' }
  if (!isRole(u.role)) return { ok: false, reason: 'invalid' }
  return { ok: true, actor: { id: u.id, orgId: u.orgId, email: u.email, role: u.role } }
}
