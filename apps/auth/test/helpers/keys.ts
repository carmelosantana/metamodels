import { generateKeyPairSync } from 'node:crypto'

const cache = new Map<number, string>()

/** Base64 of a PKCS#8 PEM RSA private key — the exact shape OIDC_SIGNING_KEY carries. Cached per size. */
export function rsaPemBase64(bits = 2048): string {
  let v = cache.get(bits)
  if (!v) {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: bits })
    v = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }) as string).toString('base64')
    cache.set(bits, v)
  }
  return v
}
