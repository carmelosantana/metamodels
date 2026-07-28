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

export function signSession(
  payload: Omit<SessionPayload, 'exp'>,
  secret: string,
  ttlMs: number,
  nowMs: number,
): string {
  const full: SessionPayload = { ...payload, exp: nowMs + ttlMs }
  const body = Buffer.from(JSON.stringify(full)).toString('base64url')
  return `${body}.${sign(body, secret)}`
}

export function verifySession(token: string, secret: string, nowMs: number): SessionPayload | null {
  const dot = token.indexOf('.')
  if (dot <= 0) return null
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = sign(body, secret)
  const sigBuf = Buffer.from(sig)
  const expBuf = Buffer.from(expected)
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const p = parsed as Record<string, unknown>
  if (
    typeof p.uid !== 'string' ||
    typeof p.oid !== 'string' ||
    !isRole(p.role) ||
    typeof p.exp !== 'number'
  ) {
    return null
  }
  if (nowMs >= p.exp) return null
  return { uid: p.uid, oid: p.oid, role: p.role as Role, exp: p.exp }
}
