import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JWK } from 'jose'
import { signJwtRs256 } from '../src/jws.js'

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })

describe('signJwtRs256', () => {
  test('signs a compact RS256 JWS that jose verifies against the public key', async () => {
    const exp = Math.floor(Date.now() / 1000) + 30
    const jwt = signJwtRs256({ typ: 'mm-consent+jwt', kid: 'k1' }, { iss: 'https://op.test', aud: 'x', exp }, rsa.privateKey)
    expect(decodeProtectedHeader(jwt)).toEqual({ typ: 'mm-consent+jwt', kid: 'k1', alg: 'RS256' })
    const jwks = createLocalJWKSet({
      keys: [{ ...(rsa.publicKey.export({ format: 'jwk' }) as JWK), kid: 'k1', alg: 'RS256' }],
    })
    const { payload } = await jwtVerify(jwt, jwks, {
      issuer: 'https://op.test', audience: 'x', typ: 'mm-consent+jwt', algorithms: ['RS256'],
    })
    expect(payload.exp).toBe(exp)
  })

  test('a header cannot choose the algorithm', () => {
    const jwt = signJwtRs256({ alg: 'none' }, {}, rsa.privateKey)
    expect(decodeProtectedHeader(jwt).alg).toBe('RS256')
  })

  test('refuses a key that cannot sign RS256', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    expect(() => signJwtRs256({}, {}, ec.privateKey)).toThrow(/RSA private key/)
    expect(() => signJwtRs256({}, {}, rsa.publicKey)).toThrow(/RSA private key/)
  })
})
