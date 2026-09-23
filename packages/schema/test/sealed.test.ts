import { randomBytes } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import {
  isSealed, loadSealKeyring, needsReseal, openSealed, parseSealKey, seal, UnsealError,
  type SealKeyring,
} from '../src/sealed.js'

const k = () => randomBytes(32).toString('base64')
const ring = (current: string, previous: string[] = []): SealKeyring =>
  loadSealKeyring({
    UPSTREAM_AUTH_KEY: current,
    ...(previous.length ? { UPSTREAM_AUTH_PREVIOUS_KEYS: previous.join(',') } : {}),
  })

describe('parseSealKey', () => {
  test('derives a stable kid from the key, so the operator never has to name one', () => {
    const raw = k()
    expect(parseSealKey(raw).kid).toBe(parseSealKey(raw).kid)
    expect(parseSealKey(raw).kid).toMatch(/^[0-9a-f]{16}$/)
    expect(parseSealKey(k()).kid).not.toBe(parseSealKey(raw).kid)
  })

  test('rejects anything that is not exactly 32 bytes of base64, without echoing it', () => {
    const short = randomBytes(16).toString('base64')
    expect(() => parseSealKey(short)).toThrow(/32 bytes/)
    try { parseSealKey(short) } catch (e) { expect(String(e)).not.toContain(short) }
    expect(() => parseSealKey('not base64 at all!!')).toThrow(/32 bytes/)
    expect(() => parseSealKey('')).toThrow(/32 bytes/)
  })
})

describe('loadSealKeyring', () => {
  test('requires UPSTREAM_AUTH_KEY', () => {
    expect(() => loadSealKeyring({})).toThrow(/UPSTREAM_AUTH_KEY is required/)
  })

  test('the current key seals; previous keys only open', () => {
    const cur = k()
    const old = k()
    const r = ring(cur, [old])
    expect(r.current.kid).toBe(parseSealKey(cur).kid)
    expect([...r.byKid.keys()].sort()).toEqual([parseSealKey(cur).kid, parseSealKey(old).kid].sort())
  })

  test('tolerates blanks and whitespace in the previous list', () => {
    const cur = k()
    const old = k()
    const r = loadSealKeyring({ UPSTREAM_AUTH_KEY: cur, UPSTREAM_AUTH_PREVIOUS_KEYS: ` ${old} ,, ` })
    expect(r.byKid.size).toBe(2)
  })

  test('rejects a key listed twice, naming the variable rather than the value', () => {
    const cur = k()
    expect(() => ring(cur, [cur])).toThrow(/UPSTREAM_AUTH_PREVIOUS_KEYS repeats a key/)
    const old = k()
    expect(() => ring(cur, [old, old])).toThrow(/UPSTREAM_AUTH_PREVIOUS_KEYS repeats a key/)
  })

  test('names which variable holds the bad key', () => {
    expect(() => ring('short')).toThrow(/UPSTREAM_AUTH_KEY/)
    expect(() => ring(k(), ['short'])).toThrow(/UPSTREAM_AUTH_PREVIOUS_KEYS\[0\]/)
  })
})

describe('seal / openSealed', () => {
  test('round-trips, and the envelope does not contain the plaintext', () => {
    const r = ring(k())
    const env = seal('hunter2-bearer-token', r)
    expect(env).not.toContain('hunter2')
    expect(isSealed(env)).toBe(true)
    expect(openSealed(env, r)).toBe('hunter2-bearer-token')
  })

  test('uses a fresh IV every time, so equal credentials do not look equal at rest', () => {
    const r = ring(k())
    expect(seal('same', r)).not.toBe(seal('same', r))
  })

  test('the envelope names the kid that sealed it', () => {
    const r = ring(k())
    expect(seal('x', r).split(':')[2]).toBe(r.current.kid)
  })

  test('a previous key still opens what it sealed — the rotation overlap window', () => {
    const old = k()
    const env = seal('x', ring(old))
    expect(openSealed(env, ring(k(), [old]))).toBe('x')
  })

  test('an envelope from a key the ring does not hold is unknown-key — the restore-from-backup case', () => {
    const env = seal('x', ring(k()))
    const err = (() => { try { openSealed(env, ring(k())) } catch (e) { return e } })()
    expect(err).toBeInstanceOf(UnsealError)
    expect((err as UnsealError).reason).toBe('unknown-key')
  })

  test('a flipped ciphertext byte is tampered, not garbage plaintext', () => {
    const r = ring(k())
    const parts = seal('secret-value', r).split(':')
    const ct = Buffer.from(parts[4], 'base64url')
    ct[0] ^= 1
    parts[4] = ct.toString('base64url')
    const err = (() => { try { openSealed(parts.join(':'), r) } catch (e) { return e } })()
    expect((err as UnsealError).reason).toBe('tampered')
  })

  test('the header is authenticated: re-labelling an envelope with another held kid is tampered', () => {
    const a = k()
    const b = k()
    const r = ring(a, [b])
    const parts = seal('x', r).split(':')
    parts[2] = parseSealKey(b).kid
    expect(() => openSealed(parts.join(':'), r)).toThrow(UnsealError)
  })

  test('plaintext and malformed values are malformed, and the error never carries the value', () => {
    const r = ring(k())
    for (const v of ['plain-token', 'sealed:v1:abc', 'sealed:v2:0000000000000000:a:b:c', '']) {
      const err = (() => { try { openSealed(v, r) } catch (e) { return e } })()
      expect((err as UnsealError).reason).toBe('malformed')
      if (v) expect((err as Error).message).not.toContain(v)
    }
  })
})

describe('needsReseal', () => {
  test('legacy plaintext and an old kid need resealing; the current kid does not', () => {
    const old = k()
    const r = ring(k(), [old])
    expect(needsReseal('plain', r)).toBe(true)
    expect(needsReseal(seal('x', ring(old)), r)).toBe(true)
    expect(needsReseal(seal('x', r), r)).toBe(false)
  })
})
