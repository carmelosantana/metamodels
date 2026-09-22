import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { adminApiResource, user } from '@metamodels/schema'
import { authorize } from '../auth/authorize'
import { freshDb, seedOrg } from '../test/db'
import {
  actorFromToken,
  credentialOf,
  grantsFromScope,
  resetAdminJwks,
  verifyAdminToken,
} from './admin-token'

describe('grantsFromScope', () => {
  test('returns a concrete set even for an absent scope (never undefined)', () => {
    const g = grantsFromScope(undefined)
    expect(g).toBeInstanceOf(Set)
    expect(g.size).toBe(0)
  })

  test('keeps only capability names and drops everything else', () => {
    const g = grantsFromScope('openid offline_access read resource.write not-a-capability')
    expect([...g].sort()).toEqual(['read', 'resource.write'])
  })

  test('is whitespace-tolerant, per RFC 6749 scope syntax', () => {
    expect([...grantsFromScope('  read   read  ')]).toEqual(['read'])
  })
})

describe('credentialOf', () => {
  test('formats client and token identity for audit_log.changed_by', () => {
    expect(credentialOf({ client_id: 'metamodels-cli', jti: 'abc' })).toBe('token:metamodels-cli:abc')
  })

  test('degrades to a stable marker when a claim is missing, never to `session`', () => {
    expect(credentialOf({})).toBe('token:unknown:unknown')
  })
})

// ---------------------------------------------------------------------------
// Round trip against a real signed RFC 9068 token and a real JWKS over HTTP.
// Task 6, Step 3 hoists this setup into a shared `test-token.ts` fixture.
// ---------------------------------------------------------------------------

const KID = 'test-key-1'
let signingKey: CryptoKey
let jwksServer: Server
let issuer: string

const CONSOLE_URL = 'https://console.example.test'

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  signingKey = privateKey
  const jwk = await exportJWK(publicKey)
  const body = JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] })

  jwksServer = createServer((req, res) => {
    if (req.url === '/jwks') {
      res.writeHead(200, { 'content-type': 'application/jwk-set+json' }).end(body)
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((done) => jwksServer.listen(0, '127.0.0.1', done))
  const addr = jwksServer.address() as AddressInfo
  issuer = `http://127.0.0.1:${addr.port}`

  // The OP is reached over the internal hop; `${issuer}/jwks` re-homed onto it is the same server here.
  process.env.OIDC_ISSUER = issuer
  process.env.OIDC_INTERNAL_URL = issuer
  process.env.CONSOLE_URL = CONSOLE_URL
  process.env.CONSOLE_CLIENT_SECRET = 'test-client-secret-value'
})

afterAll(async () => {
  await new Promise<void>((done, fail) => jwksServer.close((e) => (e ? fail(e) : done())))
})

beforeEach(() => resetAdminJwks())

async function mint(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT({ client_id: 'metamodels-cli', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: KID, typ: 'at+jwt' })
    .setIssuer(issuer)
    .setSubject(String(claims.sub ?? '11111111-1111-4111-8111-111111111111'))
    .setJti(String(claims.jti ?? 'jti-1'))
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(signingKey)
}

describe('verifyAdminToken', () => {
  test('accepts aud as a bare string and as an array; rejects a foreign audience', async () => {
    const want = adminApiResource(CONSOLE_URL)

    expect((await verifyAdminToken(await mint({ aud: want }))).client_id).toBe('metamodels-cli')
    expect((await verifyAdminToken(await mint({ aud: [want] }))).client_id).toBe('metamodels-cli')

    await expect(verifyAdminToken(await mint({ aud: 'https://elsewhere.test/api/admin' }))).rejects.toMatchObject({
      name: 'TokenError',
      reason: 'audience is not the admin API resource',
    })
  })

  test('resolves the signing key by the published `kid`, never a pinned one', async () => {
    const claims = await verifyAdminToken(await mint({ aud: adminApiResource(CONSOLE_URL), scope: 'read' }))
    expect(claims).toMatchObject({ scope: 'read', jti: 'jti-1' })
  })

  test('rejects a token signed by a key the JWKS does not publish', async () => {
    const { privateKey } = await generateKeyPair('RS256')
    const foreign = await new SignJWT({ aud: adminApiResource(CONSOLE_URL), client_id: 'metamodels-cli' })
      .setProtectedHeader({ alg: 'RS256', kid: KID, typ: 'at+jwt' })
      .setIssuer(issuer)
      .setSubject('11111111-1111-4111-8111-111111111111')
      .setJti('jti-2')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey)
    await expect(verifyAdminToken(foreign)).rejects.toMatchObject({ name: 'TokenError' })
  })

  test('rejects an ID token replayed as an access token — `typ` must be at+jwt', async () => {
    const idToken = await new SignJWT({ aud: adminApiResource(CONSOLE_URL) })
      .setProtectedHeader({ alg: 'RS256', kid: KID, typ: 'JWT' })
      .setIssuer(issuer)
      .setSubject('11111111-1111-4111-8111-111111111111')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(signingKey)
    await expect(verifyAdminToken(idToken)).rejects.toMatchObject({ name: 'TokenError' })
  })
})

describe('actorFromToken', () => {
  async function withActiveUser(role = 'admin') {
    const db = await freshDb()
    const org = await seedOrg(db)
    const [u] = await db.insert(user).values({
      orgId: org.id, email: 'op@x.io', passwordHash: 'unused', role, status: 'active',
    }).returning()
    return { db, u }
  }

  test('ALWAYS returns a concrete grants set — never undefined — even for a token carrying no capability scopes', async () => {
    const { db, u } = await withActiveUser()
    // `openid offline_access` are real OAuth scopes that are not capabilities: the intersection is empty.
    for (const scope of [undefined, '', 'openid offline_access']) {
      const actor = await actorFromToken(db, await mint({ aud: adminApiResource(CONSOLE_URL), sub: u.id, scope }))
      // `toBeInstanceOf(Set)`, not a size check: `undefined` means "no credential-level restriction",
      // which on the bearer path silently grants full role power (spec §2.3, the C3 trap).
      expect(actor.grants).toBeInstanceOf(Set)
      expect(actor.grants?.size).toBe(0)
      expect(authorize(actor, 'read')).toBe(false)
    }
  })

  test('carries the scoped capabilities and the bearer credential onto the Actor', async () => {
    const { db, u } = await withActiveUser()
    const actor = await actorFromToken(db, await mint({ aud: adminApiResource(CONSOLE_URL), sub: u.id, scope: 'read user.manage', jti: 'jti-9' }))
    expect([...(actor.grants ?? [])].sort()).toEqual(['read', 'user.manage'])
    expect(actor.credential).toBe('token:metamodels-cli:jti-9')
    expect(authorize(actor, 'read')).toBe(true)
    expect(authorize(actor, 'resource.write')).toBe(false)
  })

  test('re-reads the user row, so a deactivated subject is refused immediately', async () => {
    const { db, u } = await withActiveUser()
    await db.update(user).set({ status: 'deactivated' }).where(eq(user.id, u.id))
    await expect(actorFromToken(db, await mint({ aud: adminApiResource(CONSOLE_URL), sub: u.id, scope: 'read' }))).rejects.toMatchObject({
      name: 'TokenError',
      reason: 'subject is not an active user',
    })
  })
})
