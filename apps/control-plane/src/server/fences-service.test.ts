import { describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '@metamodels/schema'
import { freshDb, seedOrg } from '../test/db'
import { getFence, saveFence } from './fences-service'
import { NotFoundError } from './flocks-service'
import { ForbiddenError, type Actor } from '../auth/authorize'
import { buildBreedRegistry } from './flock-health'

const registry = buildBreedRegistry()
type TDb = Awaited<ReturnType<typeof freshDb>>

async function orgFlockPaddock(db: TDb, breed = 'ollama', role: Actor['role'] = 'admin') {
  const o = await seedOrg(db)
  const [f] = await db.insert(schema.flock).values({ orgId: o.id, breed, name: 'f', baseUrl: 'http://x' }).returning()
  const [p] = await db.insert(schema.paddock).values({ orgId: o.id, flockId: f.id, slug: 's', name: 'P' }).returning()
  const actor: Actor = { id: 'u1', orgId: o.id, email: `${role}@x.io`, role }
  return { o, f, p, actor }
}

describe('fences-service', () => {
  test('saves a valid ollama fence (validated + audited), then getFence returns it', async () => {
    const db = await freshDb()
    const { p, actor } = await orgFlockPaddock(db)
    const fence = await saveFence(db, actor, registry, {
      paddockId: p.id,
      constraintJson: { allowedRoutes: ['chat'], allowedModels: ['llama3'] },
      rateLimit: { windowSec: 60, max: 30 },
      quota: [{ dim: 'tokens_out', max: 100000, period: 'day' }],
    })
    expect(fence.paddockId).toBe(p.id)
    expect((fence.constraintJson as { allowedRoutes: string[] }).allowedRoutes).toEqual(['chat'])
    const got = await getFence(db, actor, p.id)
    expect(got?.id).toBe(fence.id)
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'fence.save'))
    expect(audits).toHaveLength(1)
  })

  test('saving twice updates the same fence (one per paddock)', async () => {
    const db = await freshDb()
    const { p, actor } = await orgFlockPaddock(db)
    const a = await saveFence(db, actor, registry, { paddockId: p.id, constraintJson: { allowedRoutes: ['chat'] } })
    const b = await saveFence(db, actor, registry, { paddockId: p.id, constraintJson: { allowedRoutes: ['chat', 'read'] } })
    expect(b.id).toBe(a.id)
    expect(await db.select().from(schema.fence)).toHaveLength(1)
    expect((b.constraintJson as { allowedRoutes: string[] }).allowedRoutes).toEqual(['chat', 'read'])
  })

  test('rejects an invalid constraint before any write', async () => {
    const db = await freshDb()
    const { p, actor } = await orgFlockPaddock(db)
    await expect(saveFence(db, actor, registry, { paddockId: p.id, constraintJson: { allowedRoutes: ['pull'] } }))
      .rejects.toThrow()
    expect(await db.select().from(schema.fence)).toHaveLength(0)
  })

  test('rejects an invalid rate limit before any write', async () => {
    const db = await freshDb()
    const { p, actor } = await orgFlockPaddock(db)
    await expect(saveFence(db, actor, registry, {
      paddockId: p.id, constraintJson: { allowedRoutes: ['chat'] }, rateLimit: { windowSec: 0, max: -5 },
    })).rejects.toThrow()
    expect(await db.select().from(schema.fence)).toHaveLength(0)
  })

  test('viewer cannot save a fence', async () => {
    const db = await freshDb()
    const { p, actor } = await orgFlockPaddock(db, 'ollama', 'viewer')
    await expect(saveFence(db, actor, registry, { paddockId: p.id, constraintJson: { allowedRoutes: ['chat'] } }))
      .rejects.toThrow(ForbiddenError)
  })

  test('cannot save or read a fence on a paddock in another org', async () => {
    const db = await freshDb()
    const { actor } = await orgFlockPaddock(db)
    const [otherOrg] = await db.insert(schema.org).values({ name: 'other' }).returning()
    const [of] = await db.insert(schema.flock).values({ orgId: otherOrg.id, breed: 'ollama', name: 'of', baseUrl: 'http://z' }).returning()
    const [foreign] = await db.insert(schema.paddock).values({ orgId: otherOrg.id, flockId: of.id, slug: 'fp', name: 'F' }).returning()
    await expect(saveFence(db, actor, registry, { paddockId: foreign.id, constraintJson: { allowedRoutes: ['chat'] } }))
      .rejects.toThrow(NotFoundError)
    await expect(getFence(db, actor, foreign.id)).rejects.toThrow(NotFoundError)
    expect(await db.select().from(schema.fence)).toHaveLength(0)
  })
})
