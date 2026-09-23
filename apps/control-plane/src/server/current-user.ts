import { cookies } from 'next/headers'
import { OPERATOR_SESSION_TTL_MS } from '@metamodels/schema'
import { SESSION_COOKIE, signSession, verifySession } from '../auth/session'
import { type Actor } from '../auth/authorize'
import { loadActiveActor } from './actor'
import { getDb } from './db'

export { SESSION_COOKIE } from '../auth/session'
export const SESSION_TTL_MS = OPERATOR_SESSION_TTL_MS

export function sessionSecret(): string {
  const s = process.env.SESSION_SECRET
  if (!s || s.length < 16) throw new Error('SESSION_SECRET must be set (>=16 chars)')
  return s
}

export async function getCurrentActor(): Promise<Actor | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  if (!token) return null
  const payload = verifySession(token, sessionSecret(), Date.now())
  if (!payload) return null
  // Re-load the user so a deactivated/role-changed user loses access immediately.
  return loadActiveActor(getDb(), payload.uid, 'session')
}

export async function setSessionCookie(actor: Actor): Promise<void> {
  const token = signSession(
    { uid: actor.id, oid: actor.orgId, role: actor.role },
    sessionSecret(),
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
