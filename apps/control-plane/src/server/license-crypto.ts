import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const ALGO = 'aes-256-gcm'

/** Derive a stable 32-byte key from the operator's LICENSE_KEY_SECRET. */
function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest() // 32 bytes
}

/** Encrypt a license key at rest. Output: iv(hex):authTag(hex):ciphertext(hex). */
export function encryptLicenseKey(plaintext: string, secret: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGO, deriveKey(secret), iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`
}

/** Decrypt a stored license key. Throws on format/auth-tag/tamper error. */
export function decryptLicenseKey(stored: string, secret: string): string {
  const parts = stored.split(':')
  if (parts.length !== 3) throw new Error('malformed encrypted license key')
  const [ivHex, tagHex, ctHex] = parts
  const decipher = createDecipheriv(ALGO, deriveKey(secret), Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  const pt = Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()])
  return pt.toString('utf8')
}

export function licenseLast4(plaintext: string): string {
  return plaintext.slice(-4)
}
