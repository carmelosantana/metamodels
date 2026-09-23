import { describe, expect, test } from 'vitest'
import { createHash, createPrivateKey, generateKeyPairSync } from 'node:crypto'
import { rsaThumbprint, signingJwks } from '../src/keys.js'
import { rsaPemBase64 } from './helpers/keys.js'

const pem = (b64: string) => Buffer.from(b64, 'base64').toString('utf8')

describe('signingJwks', () => {
  test('turns a configured RSA PEM into one RS256 signing key with an RFC 7638 kid', () => {
    const { keys } = signingJwks(pem(rsaPemBase64()), false)
    expect(keys).toHaveLength(1)
    const k = keys[0] as { kty: string; alg: string; use: string; kid: string; n: string; e: string; d?: string }
    expect(k).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig' })
    expect(k.d).toBeTruthy() // the OP needs the private part
    const expected = createHash('sha256').update(JSON.stringify({ e: k.e, kty: 'RSA', n: k.n })).digest('base64url')
    expect(k.kid).toBe(expected)
    expect(rsaThumbprint(k)).toBe(expected)
  })

  test('the kid is stable for one key and differs between keys', () => {
    const a1 = signingJwks(pem(rsaPemBase64()), false).keys[0].kid
    const a2 = signingJwks(pem(rsaPemBase64()), false).keys[0].kid
    const b = signingJwks(null, true).keys[0].kid
    expect(a1).toBe(a2)
    expect(b).not.toBe(a1)
  })

  test('refuses to mint a key unless ephemeral keys are allowed', () => {
    expect(() => signingJwks(null, false)).toThrow('OIDC_SIGNING_KEY is required')
  })

  test('rejects non-RSA and undersized keys', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    expect(() => signingJwks(ec, false)).toThrow('must be an RSA private key')
    expect(() => signingJwks(pem(rsaPemBase64(1024)), false)).toThrow('at least 2048 bits')
  })
})

describe('signing-key rotation overlap', () => {
  // Distinct keys, minted at test time — no key material is ever committed. rsaPemBase64()
  // caches per size, so a second 2048-bit key has to be generated here to get a distinct kid.
  const lazy = <T,>(make: () => T) => { let v: T | undefined; return () => (v ??= make()) }
  const freshPem = (type: 'rsa' | 'ed25519') =>
    (type === 'rsa' ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : generateKeyPairSync('ed25519'))
      .privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
  const currentPem = lazy(() => pem(rsaPemBase64()))
  const previousPem = lazy(() => freshPem('rsa'))
  const jwkOf = (p: string) => createPrivateKey(p).export({ format: 'jwk' }) as { n: string; e: string }

  test('previous keys are published after the signer, so they verify but never sign', () => {
    const { keys } = signingJwks(currentPem(), false, [previousPem()])
    expect(keys).toHaveLength(2)
    // oidc-provider signs with the first match, so order is the whole mechanism.
    expect(keys[0].kid).toBe(rsaThumbprint(jwkOf(currentPem())))
    expect(keys[1].kid).toBe(rsaThumbprint(jwkOf(previousPem())))
    expect(keys[0].kid).not.toBe(keys[1].kid)
  })

  test('a previous key gets the same validation as the signer', () => {
    expect(() => signingJwks(currentPem(), false, [pem(rsaPemBase64(1024))])).toThrow(/at least 2048 bits/)
    expect(() => signingJwks(currentPem(), false, [freshPem('ed25519')])).toThrow(/must be an RSA private key/)
    // ...and the same call with a well-formed previous key is accepted, so the throws above
    // are the validation rejecting the key, not the call shape being wrong.
    expect(signingJwks(currentPem(), false, [previousPem()]).keys).toHaveLength(2)
  })

  test("an empty previous list publishes exactly one key (today's behaviour)", () => {
    expect(signingJwks(currentPem(), false, []).keys).toHaveLength(1)
    expect(signingJwks(currentPem(), false).keys).toHaveLength(1)
  })

  test('an ephemeral signer can still carry previous keys', () => {
    const { keys } = signingJwks(null, true, [previousPem()])
    expect(keys).toHaveLength(2)
    expect(keys[1].kid).toBe(rsaThumbprint(jwkOf(previousPem())))
  })

  // oidc-provider rejects a duplicate `kid` at provider construction
  // (lib/helpers/initialize_keystore.js: 'jwks.keys configuration must not contain duplicate
  // "kid" values'), which kills the container at boot without naming either variable. Catch it
  // here instead, while we still know which env var is at fault.
  test('a previous key that repeats the signer is rejected, naming the variable at fault', () => {
    const kid = rsaThumbprint(jwkOf(currentPem()))
    expect(() => signingJwks(currentPem(), false, [currentPem()])).toThrow(
      `OIDC_PREVIOUS_SIGNING_KEYS must not repeat OIDC_SIGNING_KEY or another previous key (kid ${kid})`,
    )
  })

  test('two identical previous keys are rejected, naming the variable at fault', () => {
    const kid = rsaThumbprint(jwkOf(previousPem()))
    expect(() => signingJwks(currentPem(), false, [previousPem(), previousPem()])).toThrow(
      `OIDC_PREVIOUS_SIGNING_KEYS must not repeat OIDC_SIGNING_KEY or another previous key (kid ${kid})`,
    )
    // Two *distinct* previous keys remain fine — the check is about repetition, not count.
    expect(signingJwks(currentPem(), false, [previousPem(), freshPem('rsa')]).keys).toHaveLength(3)
  })
})
