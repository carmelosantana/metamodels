import { describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '@metamodels/schema'
import { freshDb, seedOrg } from '../test/db'
import { listFlocks, getFlock, saveFlock, deleteFlock, NotFoundError } from './flocks-service'
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
