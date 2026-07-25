import { createHash, randomBytes } from 'node:crypto'

export interface GeneratedKey {
  plaintext: string
  prefix: string
  hash: string
}

export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex')
}

export function generateApiKey(): GeneratedKey {
  const raw = randomBytes(24).toString('base64url')
  const plaintext = `mm_live_${raw}`
  const prefix = plaintext.slice(0, 12)
  return { plaintext, prefix, hash: hashApiKey(plaintext) }
}
