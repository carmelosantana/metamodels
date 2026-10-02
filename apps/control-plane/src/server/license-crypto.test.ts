import { describe, expect, test } from 'vitest'
import { encryptLicenseKey, decryptLicenseKey, licenseLast4 } from './license-crypto'

const SECRET = 'test-license-secret-at-least-16-chars'

describe('license-crypto', () => {
  test('encrypt → decrypt round-trips and never contains the plaintext', () => {
    const key = 'ABCD-EFGH-IJKL-MNOP'
    const enc = encryptLicenseKey(key, SECRET)
    expect(enc).not.toContain(key)
    expect(enc.split(':').length).toBe(3)
    expect(decryptLicenseKey(enc, SECRET)).toBe(key)
  })

  test('ciphertext differs each call (random IV) but both decrypt', () => {
    const a = encryptLicenseKey('SAME-KEY', SECRET)
    const b = encryptLicenseKey('SAME-KEY', SECRET)
    expect(a).not.toBe(b)
    expect(decryptLicenseKey(a, SECRET)).toBe('SAME-KEY')
    expect(decryptLicenseKey(b, SECRET)).toBe('SAME-KEY')
  })

  test('decrypt with the wrong secret throws (auth tag mismatch)', () => {
    const enc = encryptLicenseKey('SECRET-KEY', SECRET)
    expect(() => decryptLicenseKey(enc, 'a-different-secret-16chars-long')).toThrow()
  })

  test('decrypt of a tampered ciphertext throws', () => {
    // Fresh IVs make the last ciphertext byte random; looping makes any tamper that can leave
    // the byte unchanged (1 in 256 per run) fail here every time, not as a rare CI flake.
    for (let i = 0; i < 1024; i++) {
      const enc = encryptLicenseKey('SECRET-KEY', SECRET)
      const [iv, tag, ct] = enc.split(':')
      // XOR flips a bit, so the last byte always changes; writing a fixed `00` did not.
      const flipped = (parseInt(ct.slice(-2), 16) ^ 0x01).toString(16).padStart(2, '0')
      const tampered = `${iv}:${tag}:${ct.slice(0, -2)}${flipped}`
      expect(() => decryptLicenseKey(tampered, SECRET)).toThrow()
    }
  })

  test('licenseLast4 returns the last 4 chars', () => {
    expect(licenseLast4('ABCD-EFGH-IJKL-MNOP')).toBe('MNOP')
  })
})
