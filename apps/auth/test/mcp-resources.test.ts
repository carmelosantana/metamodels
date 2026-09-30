import { describe, expect, test } from 'vitest'
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { errors } from 'oidc-provider'
import * as schema from '@metamodels/schema'
import { adminApiResource, CLI_CLIENT_ID, mcpResource } from '@metamodels/schema'
import {
  makeExtraTokenClaims, makeGetResourceServerInfo, MCP_ACCESS_TOKEN_TTL, mcpRefreshPolicy, resourcesByClient, resourceServers,
} from '../src/resources.js'
import { activeOauthKeyForGrant, findPaddock } from '../src/paddocks.js'
import { makeDb, type TestDb } from './helpers/db.js'
import { CONSOLE_URL, DATA_PLANE_URL } from './helpers/flow.js'

const cimd = { clientId: 'https://mcp-client.example.test/client.json', clientIdMetadataDocument: true }
const cli = { clientId: CLI_CLIENT_ID }

async function world() {
  const db = await makeDb()
  const [o] = await db.insert(schema.org).values({ name: 'o' }).returning()
  const [u] = await db.insert(schema.user).values({ orgId: o.id, email: 'm@x.io', passwordHash: 'x', role: 'member' }).returning()
  const [f] = await db.insert(schema.flock).values({ orgId: o.id, breed: 'ollama', name: 'f', baseUrl: 'http://f' }).returning()
  const [small] = await db.insert(schema.paddock).values({ orgId: o.id, flockId: f.id, slug: 'small', name: 'Small models' }).returning()
  const [big] = await db.insert(schema.paddock).values({ orgId: o.id, flockId: f.id, slug: 'big', name: 'Big models' }).returning()
  await db.insert(schema.paddock).values({ orgId: o.id, flockId: f.id, slug: 'off', name: 'Off', status: 'disabled' })
  return { db, o, u, small, big }
}

async function oauthKey(db: TestDb, w: Awaited<ReturnType<typeof world>>, paddockId: string, grantId: string, status = 'active') {
  const [k] = await db.insert(schema.apiKey).values({
    orgId: w.o.id, name: 'k', prefix: 'oauth', hash: randomBytes(32).toString('hex'), status,
    kind: 'oauth', grantId, oauthClientId: cimd.clientId, userId: w.u.id,
  }).returning()
  await db.insert(schema.keyPaddock).values({ keyId: k.id, paddockId })
  return k.id
}

function resolver(db: TestDb) {
  return makeGetResourceServerInfo(resourceServers(CONSOLE_URL), resourcesByClient(CONSOLE_URL), {
    dataPlaneUrl: DATA_PLANE_URL,
    isActivePaddock: async (slug) => (await findPaddock(db, slug))?.status === 'active',
  })
}

describe('getResourceServerInfo — one resource per paddock (M4 D2)', () => {
  test('a CIMD client gets a 15-minute RS256 JWT scoped mcp for an active paddock', async () => {
    const { db } = await world()
    const rs = await resolver(db)(undefined, mcpResource(DATA_PLANE_URL, 'small'), cimd)
    expect(rs).toEqual({ scope: 'mcp', accessTokenFormat: 'jwt', accessTokenTTL: MCP_ACCESS_TOKEN_TTL, jwt: { sign: { alg: 'RS256' } } })
    expect(MCP_ACCESS_TOKEN_TTL).toBe(15 * 60)
  })

  test('an unknown or disabled paddock, a malformed slug and another data plane are invalid_target', async () => {
    const { db } = await world()
    for (const r of [
      mcpResource(DATA_PLANE_URL, 'nope'), mcpResource(DATA_PLANE_URL, 'off'),
      `${DATA_PLANE_URL}/p/Small/mcp`, mcpResource('https://elsewhere.test', 'small'),
    ]) {
      await expect(resolver(db)(undefined, r, cimd), r).rejects.toBeInstanceOf(errors.InvalidTarget)
    }
  })

  test('MCP resources are open only to CIMD clients; the admin API stays CLI-only', async () => {
    const { db } = await world()
    await expect(resolver(db)(undefined, mcpResource(DATA_PLANE_URL, 'small'), cli)).rejects.toBeInstanceOf(errors.InvalidTarget)
    await expect(resolver(db)(undefined, adminApiResource(CONSOLE_URL), cimd)).rejects.toBeInstanceOf(errors.InvalidTarget)
    expect((await resolver(db)(undefined, adminApiResource(CONSOLE_URL), cli)).accessTokenTTL).toBe(3600)
  })
})

describe('extraTokenClaims — the token names the key (M4 D1)', () => {
  const token = (resource: string | undefined, grantId: string | undefined) => ({
    grantId, resourceServer: resource === undefined ? undefined : { identifier: () => resource },
  })

  test('adds nothing to a token for no resource or for the admin API', async () => {
    const { db } = await world()
    const claims = makeExtraTokenClaims(db, DATA_PLANE_URL)
    expect(await claims(undefined, token(undefined, 'g1'))).toBeUndefined()
    expect(await claims(undefined, token(adminApiResource(CONSOLE_URL), 'g1'))).toBeUndefined()
  })

  test('an MCP token carries mm_kid: the active oauth key bound to its grant for its paddock', async () => {
    const w = await world()
    const kSmall = await oauthKey(w.db, w, w.small.id, 'g1')
    const kBig = await oauthKey(w.db, w, w.big.id, 'g1')
    const claims = makeExtraTokenClaims(w.db, DATA_PLANE_URL)
    expect(await claims(undefined, token(mcpResource(DATA_PLANE_URL, 'small'), 'g1'))).toEqual({ mm_kid: kSmall })
    expect(await claims(undefined, token(mcpResource(DATA_PLANE_URL, 'big'), 'g1'))).toEqual({ mm_kid: kBig })
  })

  test('a revoked key, another grant\'s key or no key at all refuses to issue with invalid_grant', async () => {
    const w = await world()
    const k = await oauthKey(w.db, w, w.small.id, 'g1')
    const claims = makeExtraTokenClaims(w.db, DATA_PLANE_URL)
    await expect(claims(undefined, token(mcpResource(DATA_PLANE_URL, 'small'), 'g2'))).rejects.toBeInstanceOf(errors.InvalidGrant)
    await expect(claims(undefined, token(mcpResource(DATA_PLANE_URL, 'small'), undefined))).rejects.toBeInstanceOf(errors.InvalidGrant)
    await w.db.update(schema.apiKey).set({ status: 'revoked' }).where(eq(schema.apiKey.id, k))
    await expect(claims(undefined, token(mcpResource(DATA_PLANE_URL, 'small'), 'g1'))).rejects.toBeInstanceOf(errors.InvalidGrant)
    expect(await activeOauthKeyForGrant(w.db, 'g1', 'small')).toBeNull()
  })
})

describe('refresh tokens for MCP clients (ruling R4)', () => {
  const policy = mcpRefreshPolicy(DATA_PLANE_URL)
  const MCP = mcpResource(DATA_PLANE_URL, 'small')
  const client = (o: { cimd?: boolean; refresh?: boolean } = {}) => ({
    clientId: 'c',
    ...(o.cimd === false ? {} : { clientIdMetadataDocument: true }),
    grantTypeAllowed: (type: string) => (type === 'refresh_token' ? o.refresh !== false : true),
  })
  const source = (resource: string | string[] | undefined, scope = 'openid mcp') => ({ resource, scopes: new Set(scope.split(' ')) })
  const ctxFor = (c: ReturnType<typeof client>) => ({ oidc: { client: c } })

  test('a CIMD client bound to an MCP resource gets a refresh token without offline_access, not tied to the OP session', async () => {
    expect(await policy.issueRefreshToken(undefined, client(), source(MCP))).toBe(true)
    expect(await policy.issueRefreshToken(undefined, client(), source([MCP, adminApiResource(CONSOLE_URL)]))).toBe(true)
    expect(await policy.expiresWithSession(ctxFor(client()), source(MCP))).toBe(false)
  })

  test('without the refresh_token grant, or for no MCP resource, the default decides', async () => {
    expect(await policy.issueRefreshToken(undefined, client({ refresh: false }), source(MCP, 'openid offline_access mcp'))).toBe(false)
    expect(await policy.issueRefreshToken(undefined, client(), source(adminApiResource(CONSOLE_URL)))).toBe(false)
    expect(await policy.issueRefreshToken(undefined, client(), source(undefined, 'openid offline_access'))).toBe(true)
    expect(await policy.expiresWithSession(ctxFor(client()), source(undefined))).toBe(true)
  })

  test('a non-CIMD client is unchanged: offline_access alone decides, even for an MCP resource', async () => {
    const plain = client({ cimd: false })
    expect(await policy.issueRefreshToken(undefined, plain, source(MCP))).toBe(false)
    expect(await policy.issueRefreshToken(undefined, plain, source(MCP, 'openid offline_access'))).toBe(true)
    expect(await policy.expiresWithSession(ctxFor(plain), source(MCP))).toBe(true)
    expect(await policy.expiresWithSession(ctxFor(plain), source(MCP, 'openid offline_access'))).toBe(false)
  })
})
