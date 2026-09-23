import { describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '@metamodels/schema'
import { freshDb, seedOrg } from '../test/db'
import { randomBytes } from 'node:crypto'
import { loadSealKeyring, openSealed, seal } from '@metamodels/schema/sealed'
import { listFlocks, getFlock, getFlockConnection, saveFlock, deleteFlock, CredentialRebindError, NotFoundError } from './flocks-service'
import { upstreamAuthKeys } from './seal-keys'
import { DEFAULT_LIMIT, encodeCursor } from './page'
import { ForbiddenError, type Actor } from '../auth/authorize'

async function actorFor(db: Awaited<ReturnType<typeof freshDb>>, role: Actor['role']): Promise<Actor> {
  const o = await seedOrg(db)
  return { id: 'u1', orgId: o.id, email: `${role}@x.io`, role, credential: 'session' }
}

const base = { breed: 'ollama', name: 'f', baseUrl: 'http://a', tlsTrust: false }

describe('flocks-service', () => {
  test('member can create a flock; it is org-scoped and audited', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'member')
    const f = await saveFlock(db, actor, {
      breed: 'ollama', name: 'local', baseUrl: 'http://localhost:11434', tlsTrust: false,
    })
    expect(f.orgId).toBe(actor.orgId)
    expect(f.name).toBe('local')
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'flock.create'))
    expect(audits).toHaveLength(1)
    expect(audits[0].actor).toBe('member@x.io')
  })

  test('viewer cannot create (ForbiddenError) and nothing is written', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'viewer')
    await expect(saveFlock(db, actor, {
      breed: 'ollama', name: 'x', baseUrl: 'http://x', tlsTrust: false,
    })).rejects.toThrow(ForbiddenError)
    expect(await db.select().from(schema.flock)).toHaveLength(0)
  })

  test('save with id updates within the org; list returns only this org', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    const created = await saveFlock(db, actor, { breed: 'ollama', name: 'a', baseUrl: 'http://a', tlsTrust: false })
    const updated = await saveFlock(db, actor, { id: created.id, breed: 'ollama', name: 'a2', baseUrl: 'http://a', tlsTrust: true })
    expect(updated.id).toBe(created.id)
    expect(updated.name).toBe('a2')
    expect(updated.tlsTrust).toBe(true)
    const list = await listFlocks(db, actor)
    expect(list).toHaveLength(1)
  })

  test('cannot update or delete a flock in another org', async () => {
    const db = await freshDb()
    const mine = await actorFor(db, 'admin')
    const [otherOrg] = await db.insert(schema.org).values({ name: 'other' }).returning()
    const [foreign] = await db.insert(schema.flock).values({
      orgId: otherOrg.id, breed: 'ollama', name: 'foreign', baseUrl: 'http://f',
    }).returning()
    await expect(saveFlock(db, mine, { id: foreign.id, breed: 'ollama', name: 'hijack', baseUrl: 'http://f', tlsTrust: false }))
      .rejects.toThrow(NotFoundError)
    await expect(deleteFlock(db, mine, foreign.id)).rejects.toThrow(NotFoundError)
    // foreign flock untouched
    const [still] = await db.select().from(schema.flock).where(eq(schema.flock.id, foreign.id))
    expect(still.name).toBe('foreign')
  })

  test('invalid input is rejected before any write', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    await expect(saveFlock(db, actor, { breed: 'notabreed', name: '', baseUrl: 'nota url', tlsTrust: false }))
      .rejects.toThrow()
    expect(await db.select().from(schema.flock)).toHaveLength(0)
  })

  test('delete removes an org flock and audits it', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    const f = await saveFlock(db, actor, { breed: 'ollama', name: 'gone', baseUrl: 'http://g', tlsTrust: false })
    await deleteFlock(db, actor, f.id)
    expect(await db.select().from(schema.flock)).toHaveLength(0)
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'flock.delete'))
    expect(audits).toHaveLength(1)
  })

  test('listFlocks paginates by id and a cursor resumes exactly after it', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    const made = []
    for (const n of ['a', 'b', 'c']) made.push(await saveFlock(db, actor, { ...base, name: n }))
    const byId = [...made].sort((x, y) => x.id.localeCompare(y.id))

    const first = await listFlocks(db, actor, { limit: 2 })
    expect(first.map((f) => f.id)).toEqual([byId[0].id, byId[1].id])

    const second = await listFlocks(db, actor, { limit: 2, cursor: encodeCursor(byId[1].id) })
    expect(second.map((f) => f.id)).toEqual([byId[2].id])
  })

  test('listFlocks without opts still returns every row (the console path is unchanged)', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    // More than one default page, so a regression that paginated the console's bare call would
    // return DEFAULT_LIMIT rows and fail here.
    const n = DEFAULT_LIMIT + 1
    await db.insert(schema.flock).values(Array.from({ length: n }, (_, i) => ({
      orgId: actor.orgId, breed: 'ollama', name: `f${i}`, baseUrl: 'http://ollama:11434',
    })))
    expect(await listFlocks(db, actor)).toHaveLength(n)
  })

  test('an empty cursor is rejected, not quietly treated as page one', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    await saveFlock(db, actor, base)
    await expect(listFlocks(db, actor, { limit: 2, cursor: '' })).rejects.toThrow()
  })

  test('getFlock is org-scoped — another org 404s rather than leaking', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    const mine = await saveFlock(db, actor, base)
    expect((await getFlock(db, actor, mine.id)).id).toBe(mine.id)

    const other = await seedOrg(db, 'other')
    const otherOrgActor: Actor = { ...actor, orgId: other.id }
    await expect(getFlock(db, otherOrgActor, mine.id)).rejects.toThrow(NotFoundError)
  })
})

describe('flocks-service — the upstream credential is write-only and sealed at rest', () => {
  const rowOf = async (db: Awaited<ReturnType<typeof freshDb>>, id: string) =>
    (await db.select().from(schema.flock).where(eq(schema.flock.id, id)))[0]

  test('is stored sealed under the current key, never as plaintext', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    const f = await saveFlock(db, actor, { ...base, upstreamAuth: 'tok-secret' })
    const row = await rowOf(db, f.id)
    expect(row.upstreamAuthEnc).not.toContain('tok-secret')
    expect(openSealed(row.upstreamAuthEnc!, upstreamAuthKeys())).toBe('tok-secret')
  })

  test('no read or write returns it, sealed or not — only whether one is stored', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    const saved = await saveFlock(db, actor, { ...base, upstreamAuth: 'tok-secret' })
    const bare = await saveFlock(db, actor, { ...base, name: 'bare' })
    const results = [saved, bare, await getFlock(db, actor, saved.id), ...await listFlocks(db, actor),
      ...await listFlocks(db, actor, { limit: 5 })]
    for (const r of results) {
      expect(Object.keys(r)).not.toContain('upstreamAuth')
      expect(Object.keys(r)).not.toContain('upstreamAuthEnc')
      expect(JSON.stringify(r)).not.toMatch(/tok-secret|sealed:v1:/)
    }
    expect(saved.hasUpstreamAuth).toBe(true)
    expect(bare.hasUpstreamAuth).toBe(false)
    expect((await getFlock(db, actor, saved.id)).hasUpstreamAuth).toBe(true)
  })

  test('an update that omits it leaves the stored credential exactly as it was', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    const f = await saveFlock(db, actor, { ...base, upstreamAuth: 'tok-secret' })
    const before = (await rowOf(db, f.id)).upstreamAuthEnc
    const updated = await saveFlock(db, actor, { ...base, id: f.id, name: 'renamed' })
    expect(updated.name).toBe('renamed')
    expect(updated.hasUpstreamAuth).toBe(true)
    // Byte-identical, not merely re-sealed: the column was never named in the UPDATE.
    expect((await rowOf(db, f.id)).upstreamAuthEnc).toBe(before)
  })

  test('null clears it; a new string replaces it', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    const f = await saveFlock(db, actor, { ...base, upstreamAuth: 'tok-1' })
    await saveFlock(db, actor, { ...base, id: f.id, upstreamAuth: 'tok-2' })
    expect(openSealed((await rowOf(db, f.id)).upstreamAuthEnc!, upstreamAuthKeys())).toBe('tok-2')
    const cleared = await saveFlock(db, actor, { ...base, id: f.id, upstreamAuth: null })
    expect(cleared.hasUpstreamAuth).toBe(false)
    expect((await rowOf(db, f.id)).upstreamAuthEnc).toBeNull()
  })

  test('the audit row says the credential changed, and never what it is', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    const f = await saveFlock(db, actor, { ...base, upstreamAuth: 'tok-secret' })
    await saveFlock(db, actor, { ...base, id: f.id, name: 'renamed' })
    await saveFlock(db, actor, { ...base, id: f.id, upstreamAuth: null })
    const audits = await db.select().from(schema.auditLog)
    expect(audits.map((a) => (a.detail as { upstreamAuth?: string }).upstreamAuth))
      .toEqual(['set', undefined, 'cleared'])
    expect(JSON.stringify(audits)).not.toMatch(/tok-secret|sealed:v1:/)
  })

  test('getFlockConnection opens it for server-side use, org-scoped', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    const f = await saveFlock(db, actor, { ...base, upstreamAuth: 'tok-secret' })
    expect(await getFlockConnection(db, actor, f.id)).toEqual({
      breed: 'ollama', baseUrl: 'http://a', tlsTrust: false, upstreamAuth: 'tok-secret',
    })
    const other = await seedOrg(db, 'other')
    await expect(getFlockConnection(db, { ...actor, orgId: other.id }, f.id)).rejects.toThrow(NotFoundError)
  })

  test('getFlockConnection reports a credential no held key opens, instead of dropping it', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    const foreign = loadSealKeyring({ UPSTREAM_AUTH_KEY: randomBytes(32).toString('base64') })
    const [f] = await db.insert(schema.flock).values({
      orgId: actor.orgId, breed: 'ollama', name: 'restored', baseUrl: 'http://a',
      upstreamAuthEnc: seal('tok', foreign),
    }).returning()
    expect(await getFlockConnection(db, actor, f.id)).toMatchObject({ upstreamAuth: null, upstreamAuthError: 'unknown-key' })
  })

  /**
   * Write-only must hold against writers too. If an omitted credential simply followed a changed
   * `baseUrl`, a `resource.write` token could point the flock at its own server and have the next
   * model listing or paddock request deliver the credential there.
   */
  describe('an omitted credential does not follow the flock somewhere new', () => {
    test('changing baseUrl without re-sending it is refused, and nothing is written', async () => {
      const db = await freshDb()
      const actor = await actorFor(db, 'admin')
      const f = await saveFlock(db, actor, { ...base, upstreamAuth: 'tok' })
      const before = await rowOf(db, f.id)
      await expect(saveFlock(db, actor, { ...base, id: f.id, baseUrl: 'https://attacker.example' }))
        .rejects.toThrow(CredentialRebindError)
      expect(await rowOf(db, f.id)).toEqual(before)
    })

    test('turning tlsTrust on without re-sending it is refused', async () => {
      const db = await freshDb()
      const actor = await actorFor(db, 'admin')
      const f = await saveFlock(db, actor, { ...base, tlsTrust: false, upstreamAuth: 'tok' })
      await expect(saveFlock(db, actor, { ...base, id: f.id, tlsTrust: true })).rejects.toThrow(CredentialRebindError)
    })

    test('re-sending it, or clearing it, alongside the change is allowed', async () => {
      const db = await freshDb()
      const actor = await actorFor(db, 'admin')
      const f = await saveFlock(db, actor, { ...base, upstreamAuth: 'tok' })
      const moved = await saveFlock(db, actor, { ...base, id: f.id, baseUrl: 'http://b', upstreamAuth: 'tok-b' })
      expect(moved.baseUrl).toBe('http://b')
      const cleared = await saveFlock(db, actor, { ...base, id: f.id, baseUrl: 'http://c', tlsTrust: true, upstreamAuth: null })
      expect(cleared).toMatchObject({ baseUrl: 'http://c', hasUpstreamAuth: false })
    })

    test('no stored credential, nothing to protect: the change goes through', async () => {
      const db = await freshDb()
      const actor = await actorFor(db, 'admin')
      const f = await saveFlock(db, actor, base)
      expect((await saveFlock(db, actor, { ...base, id: f.id, baseUrl: 'http://b', tlsTrust: true })).baseUrl).toBe('http://b')
    })

    test('turning tlsTrust OFF, or leaving baseUrl alone, keeps it without re-sending', async () => {
      const db = await freshDb()
      const actor = await actorFor(db, 'admin')
      const f = await saveFlock(db, actor, { ...base, tlsTrust: true, upstreamAuth: 'tok' })
      expect((await saveFlock(db, actor, { ...base, id: f.id, tlsTrust: false, name: 'n2' })).hasUpstreamAuth).toBe(true)
    })

    test('another org\'s flock is still a 404, not a rebind refusal that confirms it exists', async () => {
      const db = await freshDb()
      const actor = await actorFor(db, 'admin')
      const f = await saveFlock(db, actor, { ...base, upstreamAuth: 'tok' })
      const other = await seedOrg(db, 'other')
      await expect(saveFlock(db, { ...actor, orgId: other.id }, { ...base, id: f.id, baseUrl: 'http://x' }))
        .rejects.toThrow(NotFoundError)
    })
  })
})
