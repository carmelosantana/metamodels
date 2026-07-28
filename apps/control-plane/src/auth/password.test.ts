import { describe, expect, test } from 'vitest'
import { hashPassword, verifyPassword } from './password'

describe('password', () => {
  test('hash is salted, prefixed, and not the plaintext', async () => {
    const h = await hashPassword('correct horse battery staple')
    expect(h.startsWith('scrypt$')).toBe(true)
    expect(h).not.toContain('correct horse')
    const h2 = await hashPassword('correct horse battery staple')
    expect(h2).not.toBe(h) // random salt → different digest
  })

  test('verify accepts the right password and rejects the wrong one', async () => {
    const h = await hashPassword('s3cret-pass')
    expect(await verifyPassword('s3cret-pass', h)).toBe(true)
    expect(await verifyPassword('wrong', h)).toBe(false)
  })

  test('verify returns false on malformed stored values instead of throwing', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false)
    expect(await verifyPassword('x', 'scrypt$onlyonepart')).toBe(false)
    expect(await verifyPassword('x', '')).toBe(false)
  })
})
