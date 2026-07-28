import { cookies } from 'next/headers'
import { eq } from 'drizzle-orm'
import { user } from '@metamodels/schema'
import { signSession, verifySession } from '../auth/session'
import { isRole, type Actor } from '../auth/authorize'
import { getDb } from './db'

export const SESSION_COOKIE = 'mm_session'
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000

function secret(): string {
  const s = process.env.SESSION_SECRET
  if (!s || s.length < 16) throw new Error('SESSION_SECRET must be set (>=16 chars)')
  return s
}

export async function getCurrentActor(): Promise<Actor | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  if (!token) return null
  const payload = verifySession(token, secret(), Date.now())
  if (!payload) return null
  // Re-load the user so a deactivated/role-changed user loses access immediately.
  const rows = await getDb().select().from(user).where(eq(user.id, payload.uid)).limit(1)
  const u = rows[0]
  if (!u || u.status !== 'active' || !isRole(u.role)) return null
  return { id: u.id, orgId: u.orgId, email: u.email, role: u.role }
}

export async function setSessionCookie(actor: Actor): Promise<void> {
  const token = signSession(
    { uid: actor.id, oid: actor.orgId, role: actor.role },
    secret(),
    SESSION_TTL_MS,
    Date.now(),
  )
  ;(await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  })
}

export async function clearSessionCookie(): Promise<void> {
  ;(await cookies()).delete(SESSION_COOKIE)
}
