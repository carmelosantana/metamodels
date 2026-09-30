import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import {
  AUDIENCE_MISMATCH, createAccessTokenVerifier, KeySetUnavailableError, TokenError,
} from '../src/access-token.js'

const AUD = 'https://dp.example.test/p/small/mcp'
const SUB = '11111111-1111-4111-8111-111111111111'
let key: CryptoKey
let server: Server
let issuer: string
/** A port nothing listens on: bound, then released. */
let dead: string

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  key = pair.privateKey
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
  server = createServer((req, res) => {
    if (req.url === '/jwks') {
      res.writeHead(200, { 'content-type': 'application/jwk-set+json' }).end(JSON.stringify({ keys: [jwk] }))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const d = createServer()
  await new Promise<void>((r) => d.listen(0, '127.0.0.1', r))
  dead = `http://127.0.0.1:${(d.address() as AddressInfo).port}`
  await new Promise<void>((r) => d.close(() => r()))
})
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())) })

interface MintOptions { typ?: string; kid?: string; exp?: number | false; iss?: string }
function mint(claims: Record<string, unknown>, o: MintOptions = {}): Promise<string> {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: o.kid ?? 'k1', typ: o.typ ?? 'at+jwt' })
    .setIssuer(o.iss ?? issuer)
    .setSubject(SUB)
    .setIssuedAt()
    .setJti('j1')
  if (o.exp !== false) jwt.setExpirationTime(o.exp ?? '15m')
  return jwt.sign(key)
}
const verifier = (typ = 'at+jwt', jwksUrl = `${issuer}/jwks`) => createAccessTokenVerifier({ issuer, jwksUrl, typ })

describe('createAccessTokenVerifier', () => {
  test('returns the verified claims of a token bound to the audience, as a string or in an array', async () => {
    const verify = verifier()
    expect((await verify(await mint({ aud: AUD, mm_kid: 'key-1' }), AUD)).mm_kid).toBe('key-1')
    expect((await verify(await mint({ aud: [AUD] }), AUD)).sub).toBe(SUB)
  })

  test('another audience is a TokenError whose reason is AUDIENCE_MISMATCH', async () => {
    await expect(verifier()(await mint({ aud: 'https://dp.example.test/p/other/mcp' }), AUD))
      .rejects.toMatchObject({ name: 'TokenError', reason: AUDIENCE_MISMATCH })
  })

  test('typ is pinned per verifier: an access token is not an assertion, nor an assertion an access token', async () => {
    const accessToken = await mint({ aud: AUD })
    const assertion = await mint({ aud: AUD }, { typ: 'mm-consent+jwt' })
    await expect(verifier('mm-consent+jwt')(accessToken, AUD)).rejects.toBeInstanceOf(TokenError)
    await expect(verifier('at+jwt')(assertion, AUD)).rejects.toBeInstanceOf(TokenError)
    expect((await verifier('mm-consent+jwt')(assertion, AUD)).aud).toBe(AUD)
  })

  test('refuses a token with no exp, an expired one, and one from another issuer', async () => {
    const verify = verifier()
    await expect(verify(await mint({ aud: AUD }, { exp: false }), AUD)).rejects.toBeInstanceOf(TokenError)
    await expect(verify(await mint({ aud: AUD }, { exp: Math.floor(Date.now() / 1000) - 60 }), AUD))
      .rejects.toMatchObject({ reason: 'expired, judged before resolving the signing key' })
    await expect(verify(await mint({ aud: AUD }, { iss: 'https://evil.example.test' }), AUD))
      .rejects.toBeInstanceOf(TokenError)
  })

  test('an unreachable key set is KeySetUnavailableError, never a token defect', async () => {
    const err = await verifier('at+jwt', `${dead}/jwks`)(await mint({ aud: AUD }), AUD).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(KeySetUnavailableError)
    expect((err as KeySetUnavailableError).cooldownMiss).toBe(false)
  })

  test('a kid missing from a set fetched moments ago is a cooldown miss (503), not a 401', async () => {
    const verify = verifier()
    await verify(await mint({ aud: AUD }), AUD)
    await expect(verify(await mint({ aud: AUD }, { kid: 'k-new' }), AUD))
      .rejects.toMatchObject({ name: 'KeySetUnavailableError', cooldownMiss: true })
  })
})
