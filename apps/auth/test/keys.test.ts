import { describe, expect, test } from 'vitest'
import { createHash, generateKeyPairSync } from 'node:crypto'
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
