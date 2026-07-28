import { describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '@metamodels/schema'
import { freshDb, seedOrg } from '../test/db'
import { saveTemplate, deleteTemplate, listTemplates } from './templates-service'
import { NotFoundError } from './fences-service'
import { ForbiddenError, type Actor } from '../auth/authorize'

type TDb = Awaited<ReturnType<typeof freshDb>>
const GRAPH = { '4': { class_type: 'CLIPTextEncode', inputs: { text: '' } } }
const draft = (id: string) => ({
  id, graphText: JSON.stringify(GRAPH),
  params: [{ name: 'prompt', type: 'text', target: { node: '4', input: 'text' } }], cost: 1,
})

async function comfyPaddock(db: TDb, role: Actor['role'] = 'admin') {
  const o = await seedOrg(db)
  const [f] = await db.insert(schema.flock).values({ orgId: o.id, breed: 'comfyui', name: 'f', baseUrl: 'http://x' }).returning()
  const [p] = await db.insert(schema.paddock).values({ orgId: o.id, flockId: f.id, slug: 's', name: 'P' }).returning()
  const actor: Actor = { id: 'u1', orgId: o.id, email: `${role}@x.io`, role }
  return { o, f, p, actor }
}

describe('templates-service', () => {
  test('saves a template into the fence constraint_json and audits template.save', async () => {
    const db = await freshDb()
    const { p, actor } = await comfyPaddock(db)
    const tpls = await saveTemplate(db, actor, { paddockId: p.id, draft: draft('txt2img') })
    expect(tpls.map((t) => t.id)).toEqual(['txt2img'])
    const [row] = await db.select().from(schema.fence).where(eq(schema.fence.paddockId, p.id))
    expect((row.constraintJson as { templates: unknown[] }).templates).toHaveLength(1)
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'template.save'))
    expect(audits).toHaveLength(1)
  })

  test('saving the same id replaces it; a new id appends', async () => {
    const db = await freshDb()
    const { p, actor } = await comfyPaddock(db)
    await saveTemplate(db, actor, { paddockId: p.id, draft: draft('a') })
    await saveTemplate(db, actor, { paddockId: p.id, draft: { ...draft('a'), cost: 9 } })
    const two = await saveTemplate(db, actor, { paddockId: p.id, draft: draft('b') })
    expect(two.map((t) => t.id)).toEqual(['a', 'b'])
    expect(two.find((t) => t.id === 'a')!.cost).toBe(9)
    expect(await db.select().from(schema.fence)).toHaveLength(1)
  })

  test('preserves existing rateLimit/quota when writing templates', async () => {
    const db = await freshDb()
    const { p, actor } = await comfyPaddock(db)
    await db.insert(schema.fence).values({
      orgId: actor.orgId, paddockId: p.id, constraintJson: { templates: [] } as never,
      rateLimit: { windowSec: 60, max: 5 } as never, quota: [{ dim: 'jobs', max: 10, period: 'day' }] as never,
    })
    await saveTemplate(db, actor, { paddockId: p.id, draft: draft('a') })
    const [row] = await db.select().from(schema.fence).where(eq(schema.fence.paddockId, p.id))
    expect(row.rateLimit).toEqual({ windowSec: 60, max: 5 })
    expect(row.quota).toEqual([{ dim: 'jobs', max: 10, period: 'day' }])
  })

  test('deleteTemplate removes by id and audits template.delete', async () => {
    const db = await freshDb()
    const { p, actor } = await comfyPaddock(db)
    await saveTemplate(db, actor, { paddockId: p.id, draft: draft('a') })
    await saveTemplate(db, actor, { paddockId: p.id, draft: draft('b') })
    const left = await deleteTemplate(db, actor, { paddockId: p.id, templateId: 'a' })
    expect(left.map((t) => t.id)).toEqual(['b'])
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'template.delete'))
    expect(audits).toHaveLength(1)
  })

  test('rejects an invalid draft before any write', async () => {
    const db = await freshDb()
    const { p, actor } = await comfyPaddock(db)
    await expect(saveTemplate(db, actor, {
      paddockId: p.id, draft: { ...draft('x'), params: [{ name: 'p', type: 'text', target: { node: 'NOPE', input: 'text' } }] },
    })).rejects.toThrow()
    expect(await db.select().from(schema.fence)).toHaveLength(0)
  })

  test('rejects a non-comfyui paddock as not-found', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const [f] = await db.insert(schema.flock).values({ orgId: o.id, breed: 'ollama', name: 'f', baseUrl: 'http://x' }).returning()
    const [p] = await db.insert(schema.paddock).values({ orgId: o.id, flockId: f.id, slug: 's', name: 'P' }).returning()
    const actor: Actor = { id: 'u1', orgId: o.id, email: 'a@x.io', role: 'admin' }
    await expect(saveTemplate(db, actor, { paddockId: p.id, draft: draft('x') })).rejects.toThrow(NotFoundError)
  })

  test('rejects a paddock in another org as not-found', async () => {
    const db = await freshDb()
    const { p } = await comfyPaddock(db)
    const other = await seedOrg(db)
    const actor: Actor = { id: 'u2', orgId: other.id, email: 'b@x.io', role: 'admin' }
    await expect(saveTemplate(db, actor, { paddockId: p.id, draft: draft('x') })).rejects.toThrow(NotFoundError)
  })

  test('viewer cannot save a template', async () => {
    const db = await freshDb()
    const { p, actor } = await comfyPaddock(db, 'viewer')
    await expect(saveTemplate(db, actor, { paddockId: p.id, draft: draft('x') })).rejects.toThrow(ForbiddenError)
  })
})
