import { sign, type KeyObject } from 'node:crypto'

const segment = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')

/**
 * A compact RS256 JWS (RFC 7515) over `payload`, with node:crypto only. RSASSA-PKCS1-v1_5 with SHA-256
 * is node's default padding for an RSA key, which is exactly RS256. `alg` is always `RS256`, whatever
 * `header` says, so a caller cannot sign a token that names another algorithm.
 */
export function signJwtRs256(header: Record<string, unknown>, payload: Record<string, unknown>, key: KeyObject): string {
  if (key.type !== 'private' || key.asymmetricKeyType !== 'rsa') {
    throw new TypeError('signJwtRs256 needs an RSA private key')
  }
  const input = `${segment({ ...header, alg: 'RS256' })}.${segment(payload)}`
  return `${input}.${sign('sha256', Buffer.from(input), key).toString('base64url')}`
}
