import { afterEach, describe, expect, test, vi } from 'vitest'
import { freshDb, seedOrg } from '../test/db'
import { saveFlock } from './flocks-service'
import { buildBreedRegistry, listFlockModels } from './flock-health'
import type { Actor } from '../auth/authorize'

const registry = buildBreedRegistry()
afterEach(() => vi.unstubAllGlobals())

async function actorFor(db: Awaited<ReturnType<typeof freshDb>>): Promise<Actor> {
  const o = await seedOrg(db)
  return { id: 'u1', orgId: o.id, email: 'admin@x.io', role: 'admin' }
}

describe('listFlockModels', () => {
  test('returns the ollama flock’s models, org-scoped', async () => {
    const db = await freshDb()
    const actor = await actorFor(db)
    const f = await saveFlock(db, actor, { breed: 'ollama', name: 'local', baseUrl: 'http://o:11434', tlsTrust: false })
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ models: [{ name: 'qwen2.5-coder:0.5b' }] }), { status: 200 })))
    const r = await listFlockModels(registry, db, actor, f.id)
    expect(r).toEqual({ ok: true, models: ['qwen2.5-coder:0.5b'] })
  })

  test('a flock in another org is not found (no cross-org read)', async () => {
    const db = await freshDb()
    const mine = await actorFor(db)
    const otherOrg = await seedOrg(db)
    const stranger: Actor = { id: 'u2', orgId: otherOrg.id, email: 'x@y.io', role: 'admin' }
    const f = await saveFlock(db, stranger, { breed: 'ollama', name: 'theirs', baseUrl: 'http://o', tlsTrust: false })
    const r = await listFlockModels(registry, db, mine, f.id)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('not found')
  })

  test('a comfyui flock reports unsupported (models live in graphs)', async () => {
    const db = await freshDb()
    const actor = await actorFor(db)
    const f = await saveFlock(db, actor, { breed: 'comfyui', name: 'c', baseUrl: 'http://c:8188', tlsTrust: false })
    const r = await listFlockModels(registry, db, actor, f.id)
    expect(r).toEqual({ ok: false, models: [], detail: 'unsupported' })
  })
})
