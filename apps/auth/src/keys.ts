import { createHash, createPrivateKey, generateKeyPairSync, type KeyObject } from 'node:crypto'
import type { JWK } from 'oidc-provider'

const MIN_MODULUS_BITS = 2048

/** RFC 7638 thumbprint of an RSA JWK: SHA-256 over the required members in lexicographic order. */
export function rsaThumbprint(jwk: { e: string; n: string }): string {
  return createHash('sha256').update(`{"e":"${jwk.e}","kty":"RSA","n":"${jwk.n}"}`).digest('base64url')
}

/**
 * The OP's signing key set. A configured PEM wins. With none, a throwaway key is minted only when
 * explicitly allowed — every token it signs dies with the process, which is exactly why
 * production refuses it.
 */
export function signingJwks(pem: string | null, allowEphemeral: boolean): { keys: JWK[] } {
  let key: KeyObject
  if (pem) key = createPrivateKey(pem)
  else if (allowEphemeral) key = generateKeyPairSync('rsa', { modulusLength: MIN_MODULUS_BITS }).privateKey
  else throw new Error('OIDC_SIGNING_KEY is required (OIDC_ALLOW_EPHEMERAL_KEY=true is for local development only)')

  if (key.asymmetricKeyType !== 'rsa') throw new Error('OIDC_SIGNING_KEY must be an RSA private key')
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0
  if (bits < MIN_MODULUS_BITS) throw new Error(`OIDC_SIGNING_KEY must be at least ${MIN_MODULUS_BITS} bits (got ${bits})`)

  const jwk = key.export({ format: 'jwk' }) as { kty: string; n: string; e: string }
  return { keys: [{ ...jwk, kid: rsaThumbprint(jwk), alg: 'RS256', use: 'sig' } as JWK] }
}
