import { describe, expect, test } from 'vitest'
import { openJson, sealJson, signSession, verifySession } from './session'

const SECRET = 'test-secret-please-change'
const base = { uid: 'u1', oid: 'o1', role: 'admin' as const }

describe('session codec', () => {
  test('round-trips a valid token', () => {
    const now = 1_000_000
    const token = signSession(base, SECRET, 60_000, now)
    const out = verifySession(token, SECRET, now + 30_000)
    expect(out).toMatchObject({ uid: 'u1', oid: 'o1', role: 'admin' })
    expect(out?.exp).toBe(now + 60_000)
  })

  test('rejects an expired token', () => {
    const now = 1_000_000
    const token = signSession(base, SECRET, 60_000, now)
    expect(verifySession(token, SECRET, now + 60_001)).toBeNull()
  })

  test('rejects a token signed with a different secret', () => {
    const token = signSession(base, SECRET, 60_000, 0)
    expect(verifySession(token, 'other-secret', 1)).toBeNull()
  })

  test('rejects a tampered payload', () => {
    const token = signSession(base, SECRET, 60_000, 0)
    const [body, sig] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ uid: 'attacker', oid: 'o1', role: 'admin', exp: 9e15 })).toString('base64url')
    expect(verifySession(`${forged}.${sig}`, SECRET, 1)).toBeNull()
    expect(verifySession(`${body}.deadbeef`, SECRET, 1)).toBeNull()
  })

  test('rejects malformed tokens', () => {
    expect(verifySession('', SECRET, 1)).toBeNull()
    expect(verifySession('nodot', SECRET, 1)).toBeNull()
  })
})

describe('sealJson / openJson', () => {
  test('round-trips an arbitrary JSON object with an absolute expiry', () => {
    const token = sealJson({ state: 's', nonce: 'n' }, SECRET, 60_000, 1_000)
    expect(openJson(token, SECRET, 30_000)).toEqual({ state: 's', nonce: 'n', exp: 61_000 })
  })

  test('returns null once expired, when tampered, or under another secret', () => {
    const token = sealJson({ a: 1 }, SECRET, 60_000, 0)
    expect(openJson(token, SECRET, 60_000)).toBeNull()
    expect(openJson(token, 'another-secret-entirely', 1)).toBeNull()
    const [, sig] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ a: 2, exp: 9e15 })).toString('base64url')
    expect(openJson(`${forged}.${sig}`, SECRET, 1)).toBeNull()
    expect(openJson('garbage', SECRET, 1)).toBeNull()
  })

  test('session tokens are byte-compatible with the previous codec', () => {
    const token = signSession(base, SECRET, 60_000, 1_000)
    const [body] = token.split('.')
    expect(JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))).toEqual({ uid: 'u1', oid: 'o1', role: 'admin', exp: 61_000 })
  })
})
