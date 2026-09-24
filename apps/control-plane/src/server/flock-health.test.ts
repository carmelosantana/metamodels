import { afterEach, describe, expect, test, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import { flock } from '@metamodels/schema'
import { loadSealKeyring, seal } from '@metamodels/schema/sealed'
import { sharedDb, seedOrg, type TestDb } from '../test/db'
import { saveFlock } from './flocks-service'
import { buildBreedRegistry, listFlockModels, testFlockConnection, testStoredFlockConnection } from './flock-health'
import type { Actor } from '../auth/authorize'

const testDb = sharedDb()

const registry = buildBreedRegistry()
afterEach(() => vi.unstubAllGlobals())

async function actorFor(db: TestDb): Promise<Actor> {
  const o = await seedOrg(db)
  return { id: 'u1', orgId: o.id, email: 'admin@x.io', role: 'admin', credential: 'session' }
}

describe('testFlockConnection', () => {
  test('returns ok when the ollama upstream answers /api/version', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(String(url)).toBe('http://localhost:11434/api/version')
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await testFlockConnection(registry, {
      breed: 'ollama', baseUrl: 'http://localhost:11434/', tlsTrust: false,
    })
    expect(r.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  test('returns ok:false with detail when the upstream is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    const r = await testFlockConnection(registry, {
      breed: 'comfyui', baseUrl: 'http://localhost:8188', tlsTrust: false,
    })
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('ECONNREFUSED')
  })

  test('rejects an invalid breed before dispatching', async () => {
    await expect(testFlockConnection(registry, { breed: 'bogus', baseUrl: 'http://x', tlsTrust: false }))
      .rejects.toThrow()
  })
})

describe('listFlockModels', () => {
  test('returns the ollama flock’s models, org-scoped', async () => {
    const db = testDb()
    const actor = await actorFor(db)
    const f = await saveFlock(db, actor, { breed: 'ollama', name: 'local', baseUrl: 'http://o:11434', tlsTrust: false })
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ models: [{ name: 'qwen2.5-coder:0.5b' }] }), { status: 200 })))
    const r = await listFlockModels(registry, db, actor, f.id)
    expect(r).toEqual({ ok: true, models: ['qwen2.5-coder:0.5b'] })
  })

  test('a flock in another org is not found (no cross-org read)', async () => {
    const db = testDb()
    const mine = await actorFor(db)
    const otherOrg = await seedOrg(db)
    const stranger: Actor = { id: 'u2', orgId: otherOrg.id, email: 'x@y.io', role: 'admin', credential: 'session' }
    const f = await saveFlock(db, stranger, { breed: 'ollama', name: 'theirs', baseUrl: 'http://o', tlsTrust: false })
    const r = await listFlockModels(registry, db, mine, f.id)
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('not found')
  })

  test('a comfyui flock reports unsupported (models live in graphs)', async () => {
    const db = testDb()
    const actor = await actorFor(db)
    const f = await saveFlock(db, actor, { breed: 'comfyui', name: 'c', baseUrl: 'http://c:8188', tlsTrust: false })
    const r = await listFlockModels(registry, db, actor, f.id)
    expect(r).toEqual({ ok: false, models: [], detail: 'unsupported' })
  })

  test('sends the opened credential to the flock', async () => {
    const db = testDb()
    const actor = await actorFor(db)
    const f = await saveFlock(db, actor, { breed: 'ollama', name: 'local', baseUrl: 'http://o:11434', tlsTrust: false, upstreamAuth: 'up-tok' })
    const fetchMock = vi.fn(async (_u: unknown, _init?: RequestInit) =>
      new Response(JSON.stringify({ models: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await listFlockModels(registry, db, actor, f.id)
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer up-tok')
  })

  test('a credential no held key opens fails closed, without calling the flock', async () => {
    const db = testDb()
    const actor = await actorFor(db)
    const foreign = loadSealKeyring({ UPSTREAM_AUTH_KEY: randomBytes(32).toString('base64') })
    const id = randomUUID()
    const [f] = await db.insert(flock).values({
      id, orgId: actor.orgId, breed: 'ollama', name: 'restored', baseUrl: 'http://o',
      upstreamAuthEnc: seal('t', foreign, { orgId: actor.orgId, flockId: id }),
    }).returning()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await listFlockModels(registry, db, actor, f.id))
      .toEqual({ ok: false, models: [], detail: 'upstream credential unavailable' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// The console's Test for a saved flock. The flock id is the only input: the URL, TLS setting and
// credential are the stored ones, opened on the server, so nothing a caller sends can redirect the
// credential somewhere new, and nothing about it goes back to the caller.
describe('testStoredFlockConnection', () => {
  const okFetch = () => vi.fn(async (_u: unknown, _init?: RequestInit) => new Response('{}', { status: 200 }))

  test('probes the stored URL with the opened credential', async () => {
    const db = testDb()
    const actor = await actorFor(db)
    const f = await saveFlock(db, actor, { breed: 'ollama', name: 'local', baseUrl: 'http://o:11434', tlsTrust: false, upstreamAuth: 'up-tok' })
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    const r = await testStoredFlockConnection(registry, db, actor, f.id)
    expect(r).toEqual({ ok: true })
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://o:11434/api/version')
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer up-tok')
  })

  test('with no credential stored, sends no authorization header', async () => {
    const db = testDb()
    const actor = await actorFor(db)
    const f = await saveFlock(db, actor, { breed: 'comfyui', name: 'c', baseUrl: 'http://c:8188', tlsTrust: false })
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    expect(await testStoredFlockConnection(registry, db, actor, f.id)).toEqual({ ok: true })
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).has('authorization')).toBe(false)
  })

  test('a failed probe reports the failure, never the credential', async () => {
    const db = testDb()
    const actor = await actorFor(db)
    const f = await saveFlock(db, actor, { breed: 'ollama', name: 'local', baseUrl: 'http://o:11434', tlsTrust: false, upstreamAuth: 's3cr3t' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))
    const r = await testStoredFlockConnection(registry, db, actor, f.id)
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).not.toContain('s3cr3t')
  })

  test('a credential no held key opens fails closed, without calling the flock', async () => {
    const db = testDb()
    const actor = await actorFor(db)
    const foreign = loadSealKeyring({ UPSTREAM_AUTH_KEY: randomBytes(32).toString('base64') })
    const id = randomUUID()
    await db.insert(flock).values({
      id, orgId: actor.orgId, breed: 'ollama', name: 'restored', baseUrl: 'http://o',
      upstreamAuthEnc: seal('t', foreign, { orgId: actor.orgId, flockId: id }),
    })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await testStoredFlockConnection(registry, db, actor, id))
      .toEqual({ ok: false, detail: 'upstream credential unavailable' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('a flock in another org is not found, and is not probed', async () => {
    const db = testDb()
    const mine = await actorFor(db)
    const otherOrg = await seedOrg(db)
    const stranger: Actor = { id: 'u2', orgId: otherOrg.id, email: 'x@y.io', role: 'admin', credential: 'session' }
    const f = await saveFlock(db, stranger, { breed: 'ollama', name: 'theirs', baseUrl: 'http://o', tlsTrust: false, upstreamAuth: 'theirs' })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await testStoredFlockConnection(registry, db, mine, f.id)).toEqual({ ok: false, detail: 'flock not found' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
