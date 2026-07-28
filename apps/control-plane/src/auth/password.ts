import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>

const KEYLEN = 64

export async function hashPassword(plaintext: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = await scryptAsync(plaintext, salt, KEYLEN)
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`
}

export async function verifyPassword(plaintext: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  const salt = Buffer.from(parts[1], 'hex')
  const expected = Buffer.from(parts[2], 'hex')
  if (salt.length !== 16 || expected.length !== KEYLEN) return false
  const derived = await scryptAsync(plaintext, salt, KEYLEN)
  return timingSafeEqual(derived, expected)
}
