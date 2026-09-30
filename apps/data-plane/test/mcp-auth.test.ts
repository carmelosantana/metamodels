import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { mcpResource } from '@metamodels/schema'
import { KeySetUnavailableError } from '@metamodels/schema/access-token'
import { DrizzleConfigStore, type ConfigStore } from '../src/config/config-store.js'
import { authenticateMcp, mcpChallenge } from '../src/mcp/auth.js'
import { startTestIssuer, type TestIssuer } from './helpers/oauth.js'
import { quiet } from './helpers/quiet.js'
import { makeDb, seedFixture, seedOauthKey, TEST_RING, type Fixture, type TestDb } from './helpers/seed.js'

const DP = 'http://dp.test'
let op: TestIssuer
let db: TestDb
let fx: Fixture
let oauth: Awaited<ReturnType<typeof seedOauthKey>>
let warn: ReturnType<typeof vi.spyOn>

beforeAll(async () => { op = await startTestIssuer() })
afterAll(async () => { await op.close() })
beforeEach(async () => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  db = await makeDb()
  fx = await seedFixture(db)
  oauth = await seedOauthKey(db, fx)
})
afterEach(() => { warn.mockRestore() })

const deps = () => ({ dataPlaneUrl: DP, verify: op.verifier })
const store = () => new DrizzleConfigStore(db, TEST_RING)
const good = (over: Record<string, unknown> = {}) =>
  op.mint({ aud: mcpResource(DP, 'small'), scope: 'mcp', client_id: oauth.clientId, mm_kid: oauth.keyId, sub: oauth.userId, ...over })
const auth = (header: string | undefined, slug = 'small') => authenticateMcp(header, slug, deps(), store())

async function expectRefused(header: string | undefined, body: string) {
  const out = await auth(header)
  expect(out.ok).toBe(false)
  if (out.ok) return
  expect(out.res.status).toBe(401)
  expect(out.res.headers.get('www-authenticate')).toBe(mcpChallenge('small', DP))
  expect(await out.res.json()).toEqual({ error: body })
}

describe('authenticateMcp (M4 §4.2)', () => {
  test('the challenge names the paddock\'s RFC 9728 metadata document', () => {
    expect(mcpChallenge('small', DP))
      .toBe('Bearer resource_metadata="http://dp.test/.well-known/oauth-protected-resource/p/small/mcp", scope="mcp"')
  })

  test('a token for this paddock, naming its oauth key and client, is accepted', async () => {
    const out = await auth(`Bearer ${good()}`)
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.key).toMatchObject({ keyId: oauth.keyId, oauthClientId: oauth.clientId })
  })

  test('no token: 401, the missing body, the challenge', async () => {
    await expectRefused(undefined, 'missing access token')
    await expectRefused('Basic abc', 'missing access token')
  })

  test('every refused token gets one body and one challenge', async () => {
    const cases: Array<[string, string]> = [
      ['an mm_live_ key', fx.keyPlaintext],
      ['garbage', 'not.a.jwt'],
      ['another paddock\'s token', good({ aud: mcpResource(DP, 'other') })],
      ['an admin-API token', good({ aud: 'http://console.test/api/admin' })],
      ['a token without the mcp scope', good({ scope: 'read' })],
      ['a token naming no key', good({ mm_kid: undefined })],
      ['a token naming a live key', good({ mm_kid: fx.keyId })],
      ['a token from another client', good({ client_id: 'https://evil.example/client.json' })],
      ['an expired token', good({ exp: Math.floor(Date.now() / 1000) - 5 })],
      ['a token with the wrong typ', op.mint({ aud: mcpResource(DP, 'small'), mm_kid: oauth.keyId }, { typ: 'JWT' })],
    ]
    for (const [, token] of cases) await expectRefused(`Bearer ${token}`, 'invalid access token')
  })

  // Each of step 3's gates alone: every other check passes, so the logged reason names the one that refused.
  // The store is stubbed to answer a key already past expires_at, as the 30 s CachingConfigStore does for
  // a key that expired after it was cached. From Task 4 on, DrizzleConfigStore never answers an expired
  // key at all, so this is the only way to reach the gate, and the gate is what holds in that window.
  test('an oauth key past its expires_at is refused by this gate, as one cached before it expired would be', async () => {
    const live = await store().resolveKeyById(oauth.keyId)
    const cached: ConfigStore = {
      resolveKeyByHash: async () => null,
      getPaddockBySlug: async () => null,
      resolveKeyById: async () => ({ ...live!, expiresAt: new Date(Date.now() - 1_000) }),
    }
    const out = await authenticateMcp(`Bearer ${good()}`, 'small', deps(), cached)
    expect(out.ok).toBe(false)
    expect(warn).toHaveBeenLastCalledWith('[auth] 401 on /mcp: the oauth key has expired')
  })

  test('an oauth key not scoped to the requested paddock is refused, with a token minted for that paddock', async () => {
    const out = await auth(`Bearer ${good({ aud: mcpResource(DP, 'other') })}`, 'other')
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.res.status).toBe(401)
    expect(out.res.headers.get('www-authenticate')).toBe(mcpChallenge('other', DP))
    expect(await out.res.json()).toEqual({ error: 'invalid access token' })
    expect(warn).toHaveBeenLastCalledWith('[auth] 401 on /mcp: the oauth key is not scoped to this paddock')
  })

  test('a token whose client_id is not the client the key was approved for is refused', async () => {
    await expectRefused(`Bearer ${good({ client_id: 'https://evil.example/client.json' })}`, 'invalid access token')
    expect(warn).toHaveBeenLastCalledWith('[auth] 401 on /mcp: the token client is not the client the key was approved for')
  })

  test('a revoked key is refused at once, although its token is still unexpired', async () => {
    const token = good()
    const { apiKey } = await import('@metamodels/schema')
    await db.update(apiKey).set({ status: 'revoked' })
    await expectRefused(`Bearer ${token}`, 'invalid access token')
  })

  test('a key set that cannot be fetched is 503 with Retry-After: 30, not 401', async () => {
    const err = quiet('error')
    const out = await authenticateMcp(`Bearer ${good()}`, 'small', {
      dataPlaneUrl: DP, verify: async () => { throw new KeySetUnavailableError('the key set endpoint could not be reached') },
    }, store())
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.res.status).toBe(503)
    expect(out.res.headers.get('retry-after')).toBe('30')
    expect(err).toHaveBeenCalledWith('[auth] 503 on /mcp, key set unavailable: the key set endpoint could not be reached')
  })
})
