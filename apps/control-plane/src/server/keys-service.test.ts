import { describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '@metamodels/schema'
import { sharedDb, seedOrg, type TestDb } from '../test/db'
import {
  listKeys, createKey, revokeKey, NotFoundError, mintOauthKey, preflightOauthKey, oauthKeyName,
  OAUTH_KEY_PREFIX, PREFLIGHT_NO_CAPABILITY, PREFLIGHT_NO_PADDOCK,
} from './keys-service'
import { DEFAULT_LIMIT, encodeCursor } from './page'
import { ForbiddenError, type Actor } from '../auth/authorize'

const testDb = sharedDb()

async function actorFor(db: TestDb, role: Actor['role']): Promise<Actor> {
  const o = await seedOrg(db)
  return { id: 'u1', orgId: o.id, email: `${role}@x.io`, role, credential: 'session' }
}

async function paddockIn(db: TestDb, orgId: string, slug: string): Promise<string> {
  const [f] = await db.insert(schema.flock).values({
    orgId, breed: 'ollama', name: 'f', baseUrl: 'http://f',
  }).returning()
  const [p] = await db.insert(schema.paddock).values({
    orgId, flockId: f.id, slug, name: slug,
  }).returning()
  return p.id
}

describe('keys-service createKey', () => {
  test('mints an mm_live_ key; plaintext returned once, only hash+prefix stored', async () => {
    const db = testDb()
    const actor = await actorFor(db, 'member')
    const pid = await paddockIn(db, actor.orgId, 'p1')

    const created = await createKey(db, actor, { name: 'ci', paddockIds: [pid] })
    expect(created.plaintext.startsWith('mm_live_')).toBe(true)
    expect(created.prefix).toBe(created.plaintext.slice(0, 12))

    const [row] = await db.select().from(schema.apiKey).where(eq(schema.apiKey.id, created.id))
    expect(row.orgId).toBe(actor.orgId)
    expect(row.name).toBe('ci')
    expect(row.status).toBe('active')
    expect(row.prefix).toBe(created.prefix)
    // plaintext is NEVER persisted
    expect(row.hash).not.toBe(created.plaintext)
    expect(JSON.stringify(row)).not.toContain(created.plaintext)

    // scope link created
    const links = await db.select().from(schema.keyPaddock).where(eq(schema.keyPaddock.keyId, created.id))
    expect(links.map((l) => l.paddockId)).toEqual([pid])

    // audited without leaking the secret
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'key.create'))
    expect(audits).toHaveLength(1)
    expect(JSON.stringify(audits[0])).not.toContain(created.plaintext)
  })

  test('org consistency: linking a paddock in another org is rejected; nothing is written', async () => {
    const db = testDb()
    const mine = await actorFor(db, 'admin')
    const [otherOrg] = await db.insert(schema.org).values({ name: 'other' }).returning()
    const foreignPid = await paddockIn(db, otherOrg.id, 'foreign')

    await expect(createKey(db, mine, { name: 'x', paddockIds: [foreignPid] }))
      .rejects.toThrow(NotFoundError)
    expect(await db.select().from(schema.apiKey)).toHaveLength(0)
    expect(await db.select().from(schema.keyPaddock)).toHaveLength(0)
    expect(await db.select().from(schema.auditLog)).toHaveLength(0)
  })

  test('duplicate paddockIds are de-duplicated into one scope link', async () => {
    const db = testDb()
    const actor = await actorFor(db, 'admin')
    const pid = await paddockIn(db, actor.orgId, 'p1')
    const created = await createKey(db, actor, { name: 'dup', paddockIds: [pid, pid] })
    const links = await db.select().from(schema.keyPaddock).where(eq(schema.keyPaddock.keyId, created.id))
    expect(links).toHaveLength(1)
  })

  test('optional per-key rate override is validated and persisted', async () => {
    const db = testDb()
    const actor = await actorFor(db, 'admin')
    const pid = await paddockIn(db, actor.orgId, 'p1')
    const created = await createKey(db, actor, {
      name: 'o', paddockIds: [pid], overrides: { rateLimit: { windowSec: 60, max: 10 } },
    })
    const [row] = await db.select().from(schema.apiKey).where(eq(schema.apiKey.id, created.id))
    expect(row.overrides).toEqual({ rateLimit: { windowSec: 60, max: 10 } })

    await expect(createKey(db, actor, {
      name: 'bad', paddockIds: [pid], overrides: { rateLimit: { windowSec: 0, max: 10 } },
    })).rejects.toThrow()
  })

  test('viewer cannot create a key; nothing is written', async () => {
    const db = testDb()
    const actor = await actorFor(db, 'viewer')
    const pid = await paddockIn(db, actor.orgId, 'p1')
    await expect(createKey(db, actor, { name: 'x', paddockIds: [pid] })).rejects.toThrow(ForbiddenError)
    expect(await db.select().from(schema.apiKey)).toHaveLength(0)
  })

  test('listKeys returns only this org, with prefix/status/paddock slugs, no hash', async () => {
    const db = testDb()
    const actor = await actorFor(db, 'admin')
    const pid = await paddockIn(db, actor.orgId, 'p1')
    await createKey(db, actor, { name: 'a', paddockIds: [pid] })

    // a key in another org must not appear
    const [otherOrg] = await db.insert(schema.org).values({ name: 'other' }).returning()
    await db.insert(schema.apiKey).values({
      orgId: otherOrg.id, name: 'foreign', prefix: 'mm_live_zzzz', hash: 'deadbeef', status: 'active',
    })

    const rows = await listKeys(db, actor)
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('a')
    expect(rows[0].paddockSlugs).toEqual(['p1'])
    expect(rows[0]).not.toHaveProperty('hash')
  })
})

describe('keys-service revokeKey', () => {
  test('flips status to revoked and audits it', async () => {
    const db = testDb()
    const actor = await actorFor(db, 'admin')
    const pid = await paddockIn(db, actor.orgId, 'p1')
    const created = await createKey(db, actor, { name: 'k', paddockIds: [pid] })

    await revokeKey(db, actor, created.id)

    const [row] = await db.select().from(schema.apiKey).where(eq(schema.apiKey.id, created.id))
    expect(row.status).toBe('revoked')
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'key.revoke'))
    expect(audits).toHaveLength(1)
    expect(audits[0].target).toBe(`key:${created.id}`)
  })

  // Spec §3. The UPDATE test-and-sets on `status = 'active'`, so the second call matches nothing
  // and returns quietly. It does NOT throw: an already-revoked key is the state the caller asked
  // for, and NotFoundError here would become a 404 on a key the caller just retired.
  test('a second revoke is a silent no-op — still revoked, still exactly one audit row', async () => {
    const db = testDb()
    const actor = await actorFor(db, 'admin')
    const pid = await paddockIn(db, actor.orgId, 'p1')
    const created = await createKey(db, actor, { name: 'k', paddockIds: [pid] })

    await revokeKey(db, actor, created.id)
    await expect(revokeKey(db, actor, created.id)).resolves.toBeUndefined()

    const [row] = await db.select().from(schema.apiKey).where(eq(schema.apiKey.id, created.id))
    expect(row.status).toBe('revoked')
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'key.revoke'))
    expect(audits).toHaveLength(1)
    // The positive anchor: one row, and it is THIS key's. A count alone would pass against an
    // audit written for something else entirely.
    expect(audits[0].target).toBe(`key:${created.id}`)
  })

  // "Matched no row" now means three different things. Already-revoked is a no-op; the other two
  // are still 404, and must not be blurred into it by the fix.
  test('a key id that never existed is still NotFoundError', async () => {
    const db = testDb()
    const actor = await actorFor(db, 'admin')
    await expect(revokeKey(db, actor, crypto.randomUUID())).rejects.toThrow(NotFoundError)
    expect(await db.select().from(schema.auditLog)).toHaveLength(0)
  })

  test('cannot revoke a key in another org', async () => {
    const db = testDb()
    const mine = await actorFor(db, 'admin')
    const [otherOrg] = await db.insert(schema.org).values({ name: 'other' }).returning()
    const [foreign] = await db.insert(schema.apiKey).values({
      orgId: otherOrg.id, name: 'foreign', prefix: 'mm_live_zzzz', hash: 'dead', status: 'active',
    }).returning()

    await expect(revokeKey(db, mine, foreign.id)).rejects.toThrow(NotFoundError)
    const [still] = await db.select().from(schema.apiKey).where(eq(schema.apiKey.id, foreign.id))
    expect(still.status).toBe('active')
    // And a foreign key that is ALREADY revoked is still 404, not the silent no-op: the org check
    // has to be decided before the status is, or the no-op branch becomes a cross-org oracle.
    await db.update(schema.apiKey).set({ status: 'revoked' }).where(eq(schema.apiKey.id, foreign.id))
    await expect(revokeKey(db, mine, foreign.id)).rejects.toThrow(NotFoundError)
  })

  test('viewer cannot revoke', async () => {
    const db = testDb()
    const admin = await actorFor(db, 'admin')
    const pid = await paddockIn(db, admin.orgId, 'p1')
    const created = await createKey(db, admin, { name: 'k', paddockIds: [pid] })
    const viewer: Actor = { ...admin, role: 'viewer', email: 'viewer@x.io' }
    await expect(revokeKey(db, viewer, created.id)).rejects.toThrow(ForbiddenError)
  })
})

describe('keys-service listKeys pagination', () => {
  /** Two paddocks per key: a limit applied to the slug aggregation instead of the key query
   *  would return a short page here, so this test pins the limit to the key query. */
  async function threeKeysEachScopedToTwoPaddocks(db: TestDb, actor: Actor) {
    const a = await paddockIn(db, actor.orgId, 'pa')
    const b = await paddockIn(db, actor.orgId, 'pb')
    const made = []
    for (const n of ['k1', 'k2', 'k3']) made.push(await createKey(db, actor, { name: n, paddockIds: [a, b] }))
    return [...made].sort((x, y) => x.id.localeCompare(y.id))
  }

  test('listKeys paginates by id and a cursor resumes exactly after it', async () => {
    const db = testDb()
    const actor = await actorFor(db, 'admin')
    const byId = await threeKeysEachScopedToTwoPaddocks(db, actor)

    const first = await listKeys(db, actor, { limit: 2 })
    expect(first.map((k) => k.id)).toEqual([byId[0].id, byId[1].id])
    expect(first[0].paddockSlugs).toEqual(['pa', 'pb'])

    const second = await listKeys(db, actor, { limit: 2, cursor: encodeCursor(byId[1].id) })
    expect(second.map((k) => k.id)).toEqual([byId[2].id])
  })

  test('listKeys without opts still returns every row (the console path is unchanged)', async () => {
    const db = testDb()
    const actor = await actorFor(db, 'admin')
    // More than one default page of keys, each on two paddocks so the join has twice as many rows
    // as there are keys: a regression that paginated the console's bare call, or limited join rows
    // rather than keys, returns fewer than every key and fails here.
    const a = await paddockIn(db, actor.orgId, 'pa')
    const b = await paddockIn(db, actor.orgId, 'pb')
    const n = DEFAULT_LIMIT + 1
    const keys = await db.insert(schema.apiKey).values(Array.from({ length: n }, (_, i) => ({
      orgId: actor.orgId, name: `k${i}`, prefix: `mm_${i}`, hash: `hash-${i}`,
    }))).returning({ id: schema.apiKey.id })
    await db.insert(schema.keyPaddock).values(keys.flatMap((k) => [{ keyId: k.id, paddockId: a }, { keyId: k.id, paddockId: b }]))
    const all = await listKeys(db, actor)
    expect(all).toHaveLength(n)
    expect(all.every((k) => k.paddockSlugs.length === 2)).toBe(true)
  })
})

const CLIENT = 'https://client.example.test/cimd.json'

/** A real user row: an oauth key's `user_id` is a foreign key, so the actor must exist. */
async function userIn(db: TestDb, orgId: string, role: Actor['role'] = 'member'): Promise<Actor> {
  const email = `${role}-${crypto.randomUUID()}@x.io`
  const [u] = await db.insert(schema.user).values({ orgId, email, passwordHash: 'scrypt$x$y', role }).returning()
  return { id: u.id, orgId, email, role, credential: `consent:${CLIENT}:grant-1` }
}

const mintInput = (over: Partial<Parameters<typeof mintOauthKey>[2]> = {}) => ({
  clientId: CLIENT, clientName: 'Claude', paddockSlug: 'p1', grantId: 'grant-1', ...over,
})

describe('keys-service mintOauthKey (M4 D1)', () => {
  test('mints an unpresentable oauth key bound to the grant, the client, the user and one paddock', async () => {
    const db = testDb()
    const o = await seedOrg(db)
    const actor = await userIn(db, o.id)
    const pid = await paddockIn(db, o.id, 'p1')

    const minted = await mintOauthKey(db, actor, mintInput())
    expect(minted.outcome).toBe('created')
    // Nothing that could be presented comes back: no plaintext, no hash.
    expect(Object.keys(minted).sort()).toEqual(['keyId', 'outcome'])

    const [row] = await db.select().from(schema.apiKey).where(eq(schema.apiKey.id, minted.keyId))
    expect(row).toMatchObject({
      orgId: o.id, kind: 'oauth', status: 'active', prefix: OAUTH_KEY_PREFIX,
      grantId: 'grant-1', oauthClientId: CLIENT, userId: actor.id, expiresAt: null,
      name: `Claude (MCP) · ${actor.email}`,
    })
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/)

    const links = await db.select().from(schema.keyPaddock).where(eq(schema.keyPaddock.keyId, minted.keyId))
    expect(links.map((l) => l.paddockId)).toEqual([pid])

    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'key.create'))
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      target: `key:${minted.keyId}`, detail: { kind: 'oauth', client_id: CLIENT }, changedBy: actor.credential,
    })
  })

  test('the same user, client and paddock again rebinds the existing key to the new grant', async () => {
    const db = testDb()
    const o = await seedOrg(db)
    const actor = await userIn(db, o.id)
    await paddockIn(db, o.id, 'p1')
    const first = await mintOauthKey(db, actor, mintInput())
    const second = await mintOauthKey(db, actor, mintInput({ grantId: 'grant-2' }))

    expect(second).toEqual({ keyId: first.keyId, outcome: 'rebound' })
    const rows = await db.select().from(schema.apiKey)
    expect(rows).toHaveLength(1)
    expect(rows[0].grantId).toBe('grant-2')
    const rebinds = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'key.rebind'))
    expect(rebinds).toHaveLength(1)
    expect(rebinds[0]).toMatchObject({ target: `key:${first.keyId}`, detail: { kind: 'oauth', client_id: CLIENT } })
  })

  test('another paddock, another client or another user each get a key of their own', async () => {
    const db = testDb()
    const o = await seedOrg(db)
    const a = await userIn(db, o.id)
    const b = await userIn(db, o.id)
    await paddockIn(db, o.id, 'p1')
    await paddockIn(db, o.id, 'p2')
    const base = await mintOauthKey(db, a, mintInput())
    const others = [
      await mintOauthKey(db, a, mintInput({ paddockSlug: 'p2' })),
      await mintOauthKey(db, a, mintInput({ clientId: 'https://other.example.test/cimd.json' })),
      await mintOauthKey(db, b, mintInput()),
    ]
    for (const m of others) {
      expect(m.outcome).toBe('created')
      expect(m.keyId).not.toBe(base.keyId)
    }
    expect(await db.select().from(schema.apiKey)).toHaveLength(4)
  })

  test('a revoked key is never rebound: consent after a revoke mints a new one', async () => {
    const db = testDb()
    const o = await seedOrg(db)
    const actor = await userIn(db, o.id)
    await paddockIn(db, o.id, 'p1')
    const first = await mintOauthKey(db, actor, mintInput())
    await revokeKey(db, { ...actor, role: 'admin' }, first.keyId)
    const again = await mintOauthKey(db, actor, mintInput({ grantId: 'grant-2' }))
    expect(again.outcome).toBe('created')
    expect(again.keyId).not.toBe(first.keyId)
  })

  test('a viewer is refused before anything is written', async () => {
    const db = testDb()
    const o = await seedOrg(db)
    const viewer = await userIn(db, o.id, 'viewer')
    await paddockIn(db, o.id, 'p1')
    await expect(mintOauthKey(db, viewer, mintInput())).rejects.toThrow(ForbiddenError)
    expect(await db.select().from(schema.apiKey)).toHaveLength(0)
    expect(await db.select().from(schema.auditLog)).toHaveLength(0)
  })

  test('an unknown slug, a disabled paddock and another org\'s paddock are all NotFoundError', async () => {
    const db = testDb()
    const o = await seedOrg(db)
    const actor = await userIn(db, o.id)
    const disabled = await paddockIn(db, o.id, 'off')
    await db.update(schema.paddock).set({ status: 'disabled' }).where(eq(schema.paddock.id, disabled))
    const [other] = await db.insert(schema.org).values({ name: 'other' }).returning()
    await paddockIn(db, other.id, 'theirs')
    for (const paddockSlug of ['nope', 'off', 'theirs']) {
      await expect(mintOauthKey(db, actor, mintInput({ paddockSlug })), paddockSlug).rejects.toThrow(NotFoundError)
    }
    expect(await db.select().from(schema.apiKey)).toHaveLength(0)
  })

  test('the key name is "<client> (MCP) · <email>", cut at 120 characters', () => {
    expect(oauthKeyName('Claude', 'a@b.io')).toBe('Claude (MCP) · a@b.io')
    expect(oauthKeyName('x'.repeat(200), 'a@b.io')).toHaveLength(120)
  })
})

describe('keys-service preflightOauthKey (M4 D3)', () => {
  test('a member of the paddock\'s org may approve; nothing is written', async () => {
    const db = testDb()
    const o = await seedOrg(db)
    const actor = await userIn(db, o.id)
    await paddockIn(db, o.id, 'p1')
    expect(await preflightOauthKey(db, actor, 'p1')).toEqual({ allowed: true, reason: null })
    expect(await db.select().from(schema.apiKey)).toHaveLength(0)
    expect(await db.select().from(schema.auditLog)).toHaveLength(0)
  })

  test('a viewer is told why, before any button is shown', async () => {
    const db = testDb()
    const o = await seedOrg(db)
    await paddockIn(db, o.id, 'p1')
    expect(await preflightOauthKey(db, await userIn(db, o.id, 'viewer'), 'p1'))
      .toEqual({ allowed: false, reason: PREFLIGHT_NO_CAPABILITY })
  })

  test('an unknown, disabled or foreign paddock, or no slug at all, is one refusal', async () => {
    const db = testDb()
    const o = await seedOrg(db)
    const actor = await userIn(db, o.id)
    const off = await paddockIn(db, o.id, 'off')
    await db.update(schema.paddock).set({ status: 'disabled' }).where(eq(schema.paddock.id, off))
    const [other] = await db.insert(schema.org).values({ name: 'other' }).returning()
    await paddockIn(db, other.id, 'theirs')
    for (const slug of ['nope', 'off', 'theirs', null]) {
      expect(await preflightOauthKey(db, actor, slug), String(slug)).toEqual({ allowed: false, reason: PREFLIGHT_NO_PADDOCK })
    }
  })
})

describe('keys-service listKeys shows each key\'s kind and client', () => {
  test('a live key and an oauth key side by side', async () => {
    const db = testDb()
    const o = await seedOrg(db)
    const actor = await userIn(db, o.id, 'admin')
    const pid = await paddockIn(db, o.id, 'p1')
    await createKey(db, actor, { name: 'ci', paddockIds: [pid] })
    await mintOauthKey(db, actor, mintInput())
    const rows = await listKeys(db, actor)
    expect(rows.map((r) => [r.kind, r.oauthClientId]).sort()).toEqual([['live', null], ['oauth', CLIENT]])
  })
})
