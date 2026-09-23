import { createHash, createPrivateKey, generateKeyPairSync, type KeyObject } from 'node:crypto'
import type { JWK } from 'oidc-provider'

const MIN_MODULUS_BITS = 2048

/** RFC 7638 thumbprint of an RSA JWK: SHA-256 over the required members in lexicographic order. */
export function rsaThumbprint(jwk: { e: string; n: string }): string {
  return createHash('sha256').update(`{"e":"${jwk.e}","kty":"RSA","n":"${jwk.n}"}`).digest('base64url')
}

/**
 * Validates one private key and renders it as the published JWK. Shared by the signer and every
 * previous key, so a previous key can never be validated more loosely than the one that signs.
 * `source` names the env var at fault, which matters during a rotation.
 */
function toSigJwk(key: KeyObject, source: string): JWK {
  if (key.asymmetricKeyType !== 'rsa') throw new Error(`${source} must be an RSA private key`)
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0
  if (bits < MIN_MODULUS_BITS) throw new Error(`${source} must be at least ${MIN_MODULUS_BITS} bits (got ${bits})`)

  const jwk = key.export({ format: 'jwk' }) as { kty: string; n: string; e: string }
  return { ...jwk, kid: rsaThumbprint(jwk), alg: 'RS256', use: 'sig' } as JWK
}

/**
 * The OP's signing key set. A configured PEM wins. With none, a throwaway key is minted only when
 * explicitly allowed — every token it signs dies with the process, which is exactly why
 * production refuses it.
 *
 * `previousPems` are verification-only keys published AFTER the signer: oidc-provider signs with
 * the first key that matches the algorithm, so order is the whole mechanism. Without this overlap,
 * rotating the signing key invalidates every in-flight access token at once (M1 handoff). Each key
 * is a distinct RFC 7638 thumbprint, so the verifying side resolves `kid` with no bookkeeping.
 */
export function signingJwks(
  pem: string | null,
  allowEphemeral: boolean,
  previousPems: readonly string[] = [],
): { keys: JWK[] } {
  let key: KeyObject
  if (pem) key = createPrivateKey(pem)
  else if (allowEphemeral) key = generateKeyPairSync('rsa', { modulusLength: MIN_MODULUS_BITS }).privateKey
  else throw new Error('OIDC_SIGNING_KEY is required (OIDC_ALLOW_EPHEMERAL_KEY=true is for local development only)')

  return {
    keys: [
      // The signer first; everything after it verifies but never signs.
      toSigJwk(key, 'OIDC_SIGNING_KEY'),
      ...previousPems.map((p) => toSigJwk(createPrivateKey(p), 'OIDC_PREVIOUS_SIGNING_KEYS')),
    ],
  }
}
