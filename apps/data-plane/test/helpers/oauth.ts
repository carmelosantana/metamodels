import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { createAccessTokenVerifier, type AccessTokenVerifier } from '@metamodels/schema/access-token'
import { signJwtRs256 } from '@metamodels/schema/jws'

export interface TestIssuer {
  issuer: string
  jwksUrl: string
  verifier: AccessTokenVerifier
  /** An RS256 `at+jwt` from this issuer: `iss`, `iat`, `exp` (+15 min) and `jti` filled in unless given. */
  mint(claims: Record<string, unknown>, header?: Record<string, unknown>): string
  close(): Promise<void>
}

/** A stand-in OP: one RSA key, its JWKS on an ephemeral loopback port, and a minting function. */
export async function startTestIssuer(): Promise<TestIssuer> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const kid = randomUUID()
  const jwks = JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] })
  const server = createServer((req, res) => {
    if (req.url !== '/jwks') { res.statusCode = 404; res.end(); return }
    res.setHeader('content-type', 'application/json')
    res.end(jwks)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const jwksUrl = `${issuer}/jwks`
  return {
    issuer,
    jwksUrl,
    verifier: createAccessTokenVerifier({ issuer, jwksUrl, typ: 'at+jwt' }),
    mint(claims, header = {}) {
      const now = Math.floor(Date.now() / 1000)
      return signJwtRs256({ typ: 'at+jwt', kid, ...header }, { iss: issuer, iat: now, exp: now + 900, jti: randomUUID(), ...claims }, privateKey)
    },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}
