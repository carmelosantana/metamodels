import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { adminApiResource, CAPABILITIES, internalApiAudience, type Capability } from '@metamodels/schema'
import { resetAdminJwks } from './admin-token'
import { resetConsentVerifier } from './consent-assertion'

export interface TokenFixture {
  issuer: string
  consoleUrl: string
  mint(opts: {
    sub: string
    scopes?: readonly Capability[]
    aud?: string | string[]
    jti?: string
  }): Promise<string>
  /**
   * An OP consent assertion (M4 D7), signed by the same key the fixture publishes. `iatOffsetSeconds`
   * moves `iat` (and with it `exp`) that far from now, to build an assertion dated in the future.
   */
  mintConsent(
    claims: Record<string, unknown>,
    opts?: { lifetimeSeconds?: number; typ?: string; aud?: string; iatOffsetSeconds?: number },
  ): Promise<string>
  close(): Promise<void>
}

/**
 * The verifier's configuration, which the fixture repoints at its own throwaway OP. Captured and
 * restored by `close()`: this module is imported by every admin route test file, so leaving the
 * process environment rewritten would leak one suite's OP into whatever runs next in the worker.
 */
const ENV_KEYS = ['OIDC_ISSUER', 'OIDC_INTERNAL_URL', 'CONSOLE_URL', 'CONSOLE_CLIENT_SECRET', 'DATA_PLANE_URL'] as const

/** Stands up a throwaway JWKS endpoint and points the verifier's env at it. */
export async function tokenFixture(consoleUrl = 'https://console.test'): Promise<TokenFixture> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
  const jwk = await exportJWK(publicKey)
  const kid = 'test-key'

  const server: Server = createServer((req, res) => {
    if (req.url === '/jwks') {
      res.writeHead(200, { 'content-type': 'application/jwk-set+json' })
      res.end(JSON.stringify({ keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] }))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  const issuer = `http://127.0.0.1:${port}`

  const priorEnv = ENV_KEYS.map((k) => [k, process.env[k]] as const)
  process.env.OIDC_ISSUER = issuer
  process.env.OIDC_INTERNAL_URL = issuer
  process.env.CONSOLE_URL = consoleUrl
  process.env.CONSOLE_CLIENT_SECRET = 'a-secret-at-least-16-chars'
  process.env.DATA_PLANE_URL = 'https://dp.test'
  resetAdminJwks()
  resetConsentVerifier()

  return {
    issuer,
    consoleUrl,
    async mint({ sub, scopes = CAPABILITIES, aud, jti = 'jti-1' }) {
      return new SignJWT({
        scope: scopes.join(' '),
        client_id: 'metamodels-cli',
        jti,
      })
        .setProtectedHeader({ alg: 'RS256', kid, typ: 'at+jwt' })
        .setIssuer(issuer)
        .setAudience(aud ?? adminApiResource(consoleUrl))
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey)
    },
    async mintConsent(claims, opts = {}) {
      const iat = Math.floor(Date.now() / 1000) + (opts.iatOffsetSeconds ?? 0)
      return new SignJWT({ client_name: 'Test MCP client', ...claims })
        .setProtectedHeader({ alg: 'RS256', kid, typ: opts.typ ?? 'mm-consent+jwt' })
        .setIssuer(issuer)
        .setAudience(opts.aud ?? internalApiAudience(consoleUrl))
        .setIssuedAt(iat)
        .setExpirationTime(iat + (opts.lifetimeSeconds ?? 30))
        .setJti(randomUUID())
        .sign(privateKey)
    },
    async close() {
      await new Promise<void>((done, fail) => server.close((e) => (e ? fail(e) : done())))
      // Assigning `undefined` to process.env writes the literal string "undefined", so a var that
      // was unset before the fixture ran has to be deleted rather than reassigned.
      for (const [k, v] of priorEnv) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      // The cached key set points at the server just closed; leaving it would hand the next
      // fixture in this worker a dead OP.
      resetAdminJwks()
      resetConsentVerifier()
    },
  }
}

export const bearer = (t: string) => ({ authorization: `Bearer ${t}` })
