import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose'
import { adminApiResource, user } from '@metamodels/schema'
import { authorize } from '../auth/authorize'
import { freshDb, seedOrg } from '../test/db'
import {
  actorFromToken,
  credentialOf,
  grantsFromScope,
  KeySetUnavailableError,
  resetAdminJwks,
  TokenError,
  verifyAdminToken,
} from './admin-token'
import { problemForError } from './problem'

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
// actually exercised rather than assumed. The rotation tests change what is published
// (`published`) and count the fetches (`jwksRequests`).
// `test-token.ts` is the shared fixture the admin ROUTE suites use. This setup was not folded into
// it and deliberately stays here: it publishes two `kid`s, which is what makes key resolution
// testable, and `test-token.ts` publishes one because no route test needs the second.
// ---------------------------------------------------------------------------

const KID_A = 'test-key-1'
const KID_B = 'test-key-2'
/** A signer the stub does not publish until a test says so: the brand-new key of a rotation. */
const KID_C = 'test-key-3'
let keyA: CryptoKey
let keyB: CryptoKey
let keyC: CryptoKey
let jwkA: JWK
let jwkB: JWK
let jwkC: JWK
/** What the stub publishes right now. `beforeEach` resets it to A and B. */
let published: JWK[] = []
/** Every `GET /jwks` the stub has answered: the anchor for "exactly one refetch". */
let jwksRequests = 0
let jwksServer: Server
let issuer: string
/** A port nothing listens on — bound then released, so a connection there is refused. */
let deadOrigin: string

const CONSOLE_URL = 'https://console.example.test'
const SUBJECT = '11111111-1111-4111-8111-111111111111'
/** `JWKS_COOLDOWN_MS` in admin-token.ts, plus a second. */
const PAST_COOLDOWN_MS = 31 * 1000
/** `JWKS_CACHE_MAX_AGE_MS` in admin-token.ts, plus a second. */
const PAST_CACHE_MAX_AGE_MS = 10 * 60 * 1000 + 1000

beforeAll(async () => {
  const a = await generateKeyPair('RS256')
  const b = await generateKeyPair('RS256')
  const c = await generateKeyPair('RS256')
  keyA = a.privateKey
  keyB = b.privateKey
  keyC = c.privateKey
  jwkA = { ...(await exportJWK(a.publicKey)), kid: KID_A, alg: 'RS256', use: 'sig' }
  jwkB = { ...(await exportJWK(b.publicKey)), kid: KID_B, alg: 'RS256', use: 'sig' }
  jwkC = { ...(await exportJWK(c.publicKey)), kid: KID_C, alg: 'RS256', use: 'sig' }

  jwksServer = createServer((req, res) => {
    if (req.url === '/jwks') {
      jwksRequests++
      res.writeHead(200, { 'content-type': 'application/jwk-set+json' }).end(JSON.stringify({ keys: published }))
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

beforeEach(() => {
  resetAdminJwks()
  published = [jwkA, jwkB]
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/**
 * Only `Date` is faked: jose's cache and cooldown read `Date.now()`, while the fetch and the stub
 * keep real timers. `setSystemTime` then moves the verifier's clock without waiting.
 */
function fakeClock(): void {
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() })
}
function advanceClock(ms: number): void {
  vi.setSystemTime(Date.now() + ms)
}

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

  test('rejects a `kid` missing from a key set fetched during this call, after exactly one refetch', async () => {
    // Not cooling down, so jose refetches once on the miss; the fresh set still lacks the `kid`, so the
    // key is retired or forged and the answer is 401. A client refreshes on a 401, which is what gets
    // an idle CLI past a completed rotation. Spec §4.3: at most one refetch per cooldown.
    const aud = adminApiResource(CONSOLE_URL)
    fakeClock()
    await verifyAdminToken(await mint({ aud }))
    expect(jwksRequests).toBeGreaterThan(0)
    advanceClock(PAST_COOLDOWN_MS)

    const before = jwksRequests
    const unknownKid = await mint({ aud }, { kid: 'never-published' })
    await expect(verifyAdminToken(unknownKid)).rejects.toBeInstanceOf(TokenError)
    expect(jwksRequests - before).toBe(1)

    // A process with no key set yet: the one fetch that loads it is the refetch; there is no second.
    resetAdminJwks()
    const fresh = jwksRequests
    await expect(verifyAdminToken(unknownKid)).rejects.toBeInstanceOf(TokenError)
    expect(jwksRequests - fresh).toBe(1)
  })

  test('a new signer\'s `kid` inside the cooldown is 503, and verifies once the cooldown has passed', async () => {
    // The set was fetched moments ago, so jose may not refetch: the `kid` could belong to a key the
    // OP started publishing since, and the token may be fine. Only here does an unknown `kid` stay 503.
    const aud = adminApiResource(CONSOLE_URL)
    fakeClock()
    await verifyAdminToken(await mint({ aud }))
    const primed = jwksRequests

    published = [jwkC, jwkA, jwkB]
    const newSigner = await mint({ aud }, { key: keyC, kid: KID_C })
    await expect(verifyAdminToken(newSigner)).rejects.toBeInstanceOf(KeySetUnavailableError)
    expect(jwksRequests).toBe(primed)

    advanceClock(PAST_COOLDOWN_MS)
    expect((await verifyAdminToken(newSigner)).sub).toBe(SUBJECT)
    expect(jwksRequests - primed).toBe(1)
  })

  test('an EXPIRED token signed by a retired key is 401, although jose resolves the key before `exp`', async () => {
    // A retired key leaves the verifier only when its cached set is refetched. Here the cache ages out
    // (`cacheMaxAge`), so jose reloads at the start of the call, and that one fetch lacks key A.
    const aud = adminApiResource(CONSOLE_URL)
    fakeClock()
    await verifyAdminToken(await mint({ aud }))
    published = [jwkB]
    advanceClock(PAST_CACHE_MAX_AGE_MS)

    const before = jwksRequests
    const expiredRetired = await mint({ aud }, { key: keyA, kid: KID_A, exp: nowSeconds() - 3600 })
    await expect(verifyAdminToken(expiredRetired)).rejects.toBeInstanceOf(TokenError)
    expect(jwksRequests - before).toBe(1)
  })

  test('a 503 is logged with its reason and cause, and never the token', async () => {
    const aud = adminApiResource(CONSOLE_URL)
    fakeClock()
    await verifyAdminToken(await mint({ aud }))
    published = [jwkC, jwkA, jwkB]
    const newSigner = await mint({ aud }, { key: keyC, kid: KID_C })
    const err = await verifyAdminToken(newSigner).then(() => undefined, (e: unknown) => e)
    expect(err).toBeInstanceOf(KeySetUnavailableError)

    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(problemForError(err).status).toBe(503)
    expect(log).toHaveBeenCalledTimes(1)
    const line = log.mock.calls[0]!.map(String).join(' ')
    expect(line).toContain((err as KeySetUnavailableError).reason)
    expect(line).toContain('JWKSNoMatchingKey')
    for (const part of [newSigner, ...newSigner.split('.')]) expect(line).not.toContain(part)
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
