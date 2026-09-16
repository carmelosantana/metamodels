import { createHmac, timingSafeEqual } from 'node:crypto'
import { isRole, type Role } from './authorize'

export interface SessionPayload {
  uid: string
  oid: string
  role: Role
  exp: number
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url')
}

/** Seal any JSON object with an absolute expiry: `base64url(json).base64url(hmac-sha256)`. */
export function sealJson(payload: Record<string, unknown>, secret: string, ttlMs: number, nowMs: number): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: nowMs + ttlMs })).toString('base64url')
  return `${body}.${sign(body, secret)}`
}

/** Open a sealJson token. Null on a bad signature, a malformed body, or a missing or elapsed expiry. */
export function openJson(token: string, secret: string, nowMs: number): Record<string, unknown> | null {
  const dot = token.indexOf('.')
  if (dot <= 0) return null
  const body = token.slice(0, dot)
  const sigBuf = Buffer.from(token.slice(dot + 1))
  const expBuf = Buffer.from(sign(body, secret))
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const p = parsed as Record<string, unknown>
  if (typeof p.exp !== 'number' || nowMs >= p.exp) return null
  return p
}

export function signSession(
  payload: Omit<SessionPayload, 'exp'>,
  secret: string,
  ttlMs: number,
  nowMs: number,
): string {
  return sealJson({ uid: payload.uid, oid: payload.oid, role: payload.role }, secret, ttlMs, nowMs)
}

export function verifySession(token: string, secret: string, nowMs: number): SessionPayload | null {
  const p = openJson(token, secret, nowMs)
  if (!p) return null
  if (typeof p.uid !== 'string' || typeof p.oid !== 'string' || !isRole(p.role)) return null
  return { uid: p.uid, oid: p.oid, role: p.role as Role, exp: p.exp as number }
}
