import { describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '@metamodels/schema'
import { freshDb, seedOrg } from '../test/db'
import { listPaddocks, getPaddock, savePaddock, deletePaddock, setPaddockStatus, SlugTakenError } from './paddocks-service'
import { DEFAULT_LIMIT, encodeCursor } from './page'
import { NotFoundError } from './flocks-service'
import { ForbiddenError, type Actor } from '../auth/authorize'

type TDb = Awaited<ReturnType<typeof freshDb>>

async function orgWithFlock(db: TDb, role: Actor['role'] = 'admin') {
  const o = await seedOrg(db)
  const [f] = await db.insert(schema.flock).values({ orgId: o.id, breed: 'ollama', name: 'f', baseUrl: 'http://x' }).returning()
  const actor: Actor = { id: 'u1', orgId: o.id, email: `${role}@x.io`, role, credential: 'session' }
  return { o, f, actor }
}

describe('paddocks-service', () => {
  test('member creates a paddock on an org flock; org-scoped + audited', async () => {
    const db = await freshDb()
    const { f, actor } = await orgWithFlock(db, 'member')
    const p = await savePaddock(db, actor, { flockId: f.id, name: 'Small', slug: 'small', status: 'active', theme: 'plain' })
    expect(p.orgId).toBe(actor.orgId)
    expect(p.slug).toBe('small')
    expect(p.theme).toBe('plain')
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'paddock.create'))
    expect(audits).toHaveLength(1)
    expect(audits[0].actor).toBe('member@x.io')
  })

  test('viewer cannot create (ForbiddenError), nothing written', async () => {
    const db = await freshDb()
    const { f, actor } = await orgWithFlock(db, 'viewer')
    await expect(savePaddock(db, actor, { flockId: f.id, name: 'x', slug: 'x', status: 'active', theme: 'plain' }))
      .rejects.toThrow(ForbiddenError)
    expect(await db.select().from(schema.paddock)).toHaveLength(0)
  })

  test('cannot attach a paddock to a flock in another org (NotFoundError)', async () => {
    const db = await freshDb()
    const { actor } = await orgWithFlock(db)
    const [otherOrg] = await db.insert(schema.org).values({ name: 'other' }).returning()
    const [foreignFlock] = await db.insert(schema.flock).values({ orgId: otherOrg.id, breed: 'ollama', name: 'ff', baseUrl: 'http://y' }).returning()
    await expect(savePaddock(db, actor, { flockId: foreignFlock.id, name: 'hj', slug: 'hj', status: 'active', theme: 'plain' }))
      .rejects.toThrow(NotFoundError)
    expect(await db.select().from(schema.paddock)).toHaveLength(0)
  })

  test('duplicate slug is rejected with SlugTakenError, not a raw DB error', async () => {
    const db = await freshDb()
    const { f, actor } = await orgWithFlock(db)
    await savePaddock(db, actor, { flockId: f.id, name: 'A', slug: 'dup', status: 'active', theme: 'plain' })
    await expect(savePaddock(db, actor, { flockId: f.id, name: 'B', slug: 'dup', status: 'active', theme: 'plain' }))
      .rejects.toThrow(SlugTakenError)
    expect(await db.select().from(schema.paddock)).toHaveLength(1)
  })

  test('invalid slug shape is rejected before any write', async () => {
    const db = await freshDb()
    const { f, actor } = await orgWithFlock(db)
    await expect(savePaddock(db, actor, { flockId: f.id, name: 'A', slug: 'Not A Slug', status: 'active', theme: 'plain' }))
      .rejects.toThrow()
    expect(await db.select().from(schema.paddock)).toHaveLength(0)
  })

  test('update changes fields within the org; list is org-scoped', async () => {
    const db = await freshDb()
    const { f, actor } = await orgWithFlock(db)
    const created = await savePaddock(db, actor, { flockId: f.id, name: 'A', slug: 'a', status: 'active', theme: 'plain' })
    const updated = await savePaddock(db, actor, { id: created.id, flockId: f.id, name: 'A2', slug: 'a', status: 'active', theme: 'metaboy' })
    expect(updated.id).toBe(created.id)
    expect(updated.name).toBe('A2')
    expect(updated.theme).toBe('metaboy')
    expect(await listPaddocks(db, actor)).toHaveLength(1)
  })

  test('cannot update or delete a paddock in another org', async () => {
    const db = await freshDb()
    const { actor } = await orgWithFlock(db)
    const [otherOrg] = await db.insert(schema.org).values({ name: 'other' }).returning()
    const [oFlock] = await db.insert(schema.flock).values({ orgId: otherOrg.id, breed: 'ollama', name: 'of', baseUrl: 'http://z' }).returning()
    const [foreign] = await db.insert(schema.paddock).values({ orgId: otherOrg.id, flockId: oFlock.id, slug: 'foreign', name: 'F' }).returning()
    await expect(deletePaddock(db, actor, foreign.id)).rejects.toThrow(NotFoundError)
    await expect(setPaddockStatus(db, actor, foreign.id, 'disabled')).rejects.toThrow(NotFoundError)
    const [still] = await db.select().from(schema.paddock).where(eq(schema.paddock.id, foreign.id))
    expect(still.status).toBe('active')
  })

  test('setPaddockStatus toggles status and audits it', async () => {
    const db = await freshDb()
    const { f, actor } = await orgWithFlock(db)
    const p = await savePaddock(db, actor, { flockId: f.id, name: 'A', slug: 'a', status: 'active', theme: 'plain' })
    const disabled = await setPaddockStatus(db, actor, p.id, 'disabled')
    expect(disabled.status).toBe('disabled')
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'paddock.status'))
    expect(audits).toHaveLength(1)
    expect(audits[0].detail).toMatchObject({ status: 'disabled' })
  })

  test('delete removes an org paddock and audits it', async () => {
    const db = await freshDb()
    const { f, actor } = await orgWithFlock(db)
    const p = await savePaddock(db, actor, { flockId: f.id, name: 'A', slug: 'a', status: 'active', theme: 'plain' })
    await deletePaddock(db, actor, p.id)
    expect(await db.select().from(schema.paddock)).toHaveLength(0)
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'paddock.delete'))
    expect(audits).toHaveLength(1)
  })

  test('listPaddocks paginates by id and a cursor resumes exactly after it', async () => {
    const db = await freshDb()
    const { f, actor } = await orgWithFlock(db)
    const made = []
    for (const s of ['a', 'b', 'c']) {
      made.push(await savePaddock(db, actor, { flockId: f.id, name: s, slug: s, status: 'active', theme: 'plain' }))
    }
    const byId = [...made].sort((x, y) => x.id.localeCompare(y.id))

    const first = await listPaddocks(db, actor, { limit: 2 })
    expect(first.map((p) => p.id)).toEqual([byId[0].id, byId[1].id])

    const second = await listPaddocks(db, actor, { limit: 2, cursor: encodeCursor(byId[1].id) })
    expect(second.map((p) => p.id)).toEqual([byId[2].id])
  })

  test('listPaddocks without opts still returns every row (the console path is unchanged)', async () => {
    const db = await freshDb()
    const { f, actor } = await orgWithFlock(db)
    // More than one default page, so a regression that paginated the console's bare call would
    // return DEFAULT_LIMIT rows and fail here.
    const n = DEFAULT_LIMIT + 1
    await db.insert(schema.paddock).values(Array.from({ length: n }, (_, i) => ({
      orgId: actor.orgId, flockId: f.id, name: `p${i}`, slug: `p${i}`,
    })))
    expect(await listPaddocks(db, actor)).toHaveLength(n)
  })

  test('getPaddock is org-scoped — another org 404s rather than leaking', async () => {
    const db = await freshDb()
    const { f, actor } = await orgWithFlock(db)
    const mine = await savePaddock(db, actor, { flockId: f.id, name: 'A', slug: 'a', status: 'active', theme: 'plain' })
    expect((await getPaddock(db, actor, mine.id)).id).toBe(mine.id)

    const other = await seedOrg(db, 'other')
    const otherOrgActor: Actor = { ...actor, orgId: other.id }
    await expect(getPaddock(db, otherOrgActor, mine.id)).rejects.toThrow(NotFoundError)
  })
})
