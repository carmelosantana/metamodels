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
  KeySetUnavailableError,
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
// Two keys are published under different `kid`s so that key resolution is
// actually exercised rather than assumed.
// Task 6, Step 3 hoists this setup into a shared `test-token.ts` fixture.
// ---------------------------------------------------------------------------

const KID_A = 'test-key-1'
const KID_B = 'test-key-2'
let keyA: CryptoKey
let keyB: CryptoKey
let jwksServer: Server
let issuer: string
/** A port nothing listens on — bound then released, so a connection there is refused. */
let deadOrigin: string

const CONSOLE_URL = 'https://console.example.test'
const SUBJECT = '11111111-1111-4111-8111-111111111111'

beforeAll(async () => {
  const a = await generateKeyPair('RS256')
  const b = await generateKeyPair('RS256')
  keyA = a.privateKey
  keyB = b.privateKey
  const body = JSON.stringify({
    keys: [
      { ...(await exportJWK(a.publicKey)), kid: KID_A, alg: 'RS256', use: 'sig' },
      { ...(await exportJWK(b.publicKey)), kid: KID_B, alg: 'RS256', use: 'sig' },
    ],
  })

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

  const dead = createServer()
  await new Promise<void>((done) => dead.listen(0, '127.0.0.1', done))
  deadOrigin = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`
  await new Promise<void>((done, fail) => dead.close((e) => (e ? fail(e) : done())))

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

interface MintOptions {
  /** Signing key. Defaults to the SECOND published key, so the happy path must resolve by `kid`. */
  key?: CryptoKey
  /** `kid` header. Defaults to the second published key's. */
  kid?: string
  /** Absolute NumericDate for `exp`; `false` mints a token carrying no `exp` claim at all. */
  exp?: number | false
}

async function mint(claims: Record<string, unknown> = {}, opts: MintOptions = {}): Promise<string> {
  const jwt = new SignJWT({ client_id: 'metamodels-cli', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: opts.kid ?? KID_B, typ: 'at+jwt' })
    .setIssuer(issuer)
    .setSubject(String(claims.sub ?? SUBJECT))
    .setJti(String(claims.jti ?? 'jti-1'))
    .setIssuedAt()
  if (opts.exp !== false) jwt.setExpirationTime(opts.exp ?? '1h')
  return jwt.sign(opts.key ?? keyB)
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

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
    const aud = adminApiResource(CONSOLE_URL)
    // The JWKS publishes two keys. Both verify when the header names them, so no single key is pinned.
    expect((await verifyAdminToken(await mint({ aud }, { key: keyA, kid: KID_A }))).sub).toBe(SUBJECT)
    expect((await verifyAdminToken(await mint({ aud }, { key: keyB, kid: KID_B }))).sub).toBe(SUBJECT)

    // And `kid` genuinely selects the key: naming A while signing with B must fail, so an
    // implementation that simply tried every published key would not pass this.
    await expect(verifyAdminToken(await mint({ aud }, { key: keyB, kid: KID_A }))).rejects.toMatchObject({
      name: 'TokenError',
    })
  })

  test('extracts scope, client_id and jti onto AdminClaims', async () => {
    const claims = await verifyAdminToken(await mint({ aud: adminApiResource(CONSOLE_URL), scope: 'read' }))
    expect(claims).toMatchObject({ sub: SUBJECT, scope: 'read', client_id: 'metamodels-cli', jti: 'jti-1' })
  })

  test('rejects a token signed by a key the JWKS does not publish', async () => {
    const { privateKey } = await generateKeyPair('RS256')
    const foreign = await mint({ aud: adminApiResource(CONSOLE_URL), jti: 'jti-2' }, { key: privateKey })
    await expect(verifyAdminToken(foreign)).rejects.toMatchObject({ name: 'TokenError' })
  })

  test('treats a `kid` the JWKS does not publish as a key-set failure, not a token rejection', async () => {
    // Deliberate, and the one debatable arm of the split: a `kid` absent from the published set is
    // what a live rotation looks like from inside jose's cooldown window, where the token is fine and
    // refreshing it cannot help. The cost is that a forged `kid` also lands here, so this arm answers
    // 503 for a request an attacker controls — noisy in availability metrics, but harmless to others.
    const unknownKid = await mint({ aud: adminApiResource(CONSOLE_URL) }, { kid: 'never-published' })
    await expect(verifyAdminToken(unknownKid)).rejects.toBeInstanceOf(KeySetUnavailableError)
  })

  test('rejects an ID token replayed as an access token — `typ` must be at+jwt', async () => {
    const idToken = await new SignJWT({ aud: adminApiResource(CONSOLE_URL) })
      .setProtectedHeader({ alg: 'RS256', kid: KID_B, typ: 'JWT' })
      .setIssuer(issuer)
      .setSubject(SUBJECT)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(keyB)
    await expect(verifyAdminToken(idToken)).rejects.toMatchObject({ name: 'TokenError' })
  })

  test('rejects an expired token', async () => {
    const expired = await mint({ aud: adminApiResource(CONSOLE_URL) }, { exp: nowSeconds() - 3600 })
    await expect(verifyAdminToken(expired)).rejects.toMatchObject({ name: 'TokenError' })
  })

  test('rejects a token carrying no `exp` at all — RFC 9068 requires it, and this path has no revocation', async () => {
    // jose only checks `exp` when the claim is present, so an omitted `exp` would otherwise mint an
    // eternal bearer: offline verification, no introspection, nothing to revoke short of key rotation.
    const eternal = await mint({ aud: adminApiResource(CONSOLE_URL) }, { exp: false })
    await expect(verifyAdminToken(eternal)).rejects.toMatchObject({ name: 'TokenError' })
  })

  test('reports an unreachable OP as a key-set failure, not as an invalid token', async () => {
    const token = await mint({ aud: adminApiResource(CONSOLE_URL) })
    const restore = process.env.OIDC_INTERNAL_URL
    process.env.OIDC_INTERNAL_URL = deadOrigin
    resetAdminJwks()
    try {
      // A perfectly good token must NOT be reported as invalid when the fault is ours: the caller
      // needs to answer 503, not 401, or clients respond by refreshing a token that was already fine.
      const err = await verifyAdminToken(token).then(
        () => undefined,
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(KeySetUnavailableError)
      expect((err as Error).name).not.toBe('TokenError')
      // The cause is kept for server-side logging; the message stays free of token specifics.
      expect((err as Error).cause).toBeDefined()
    } finally {
      // Assigning `undefined` to process.env writes the literal string "undefined", so delete instead.
      if (restore === undefined) delete process.env.OIDC_INTERNAL_URL
      else process.env.OIDC_INTERNAL_URL = restore
      resetAdminJwks()
    }
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
