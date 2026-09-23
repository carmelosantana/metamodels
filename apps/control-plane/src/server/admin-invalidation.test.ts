import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { flock, org, paddock, user } from '@metamodels/schema'
import { freshDb, seedOrg, type TestDb } from '../test/db'
import { bearer, tokenFixture, type TokenFixture } from './test-token'
import * as flocks from '../app/api/admin/v1/flocks/route'
import * as flockItem from '../app/api/admin/v1/flocks/[id]/route'
import * as keys from '../app/api/admin/v1/keys/route'
import * as revokeRoute from '../app/api/admin/v1/keys/[id]/revoke/route'
import * as paddocks from '../app/api/admin/v1/paddocks/route'
import * as paddockItem from '../app/api/admin/v1/paddocks/[id]/route'
import * as statusRoute from '../app/api/admin/v1/paddocks/[id]/status/route'
import * as fenceRoute from '../app/api/admin/v1/paddocks/[id]/fence/route'
import * as templates from '../app/api/admin/v1/paddocks/[id]/templates/route'
import * as templateItem from '../app/api/admin/v1/paddocks/[id]/templates/[tid]/route'

// Every route module imports `getDb` and the publisher from these very module ids, so one mock of
// each covers them all. The publisher is a spy: these tests are about WHETHER and WITH WHAT the
// data plane is told to drop its config cache, not about Redis.
const held = vi.hoisted(() => ({ db: undefined as unknown }))
vi.mock('./db', () => ({ getDb: () => held.db }))
const publish = vi.hoisted(() => vi.fn(async (_reason: string) => {}))
vi.mock('./config-publisher', () => ({ publishConfigInvalidation: publish }))

let tok: TokenFixture
beforeAll(async () => { tok = await tokenFixture() })
afterAll(async () => { await tok.close() })

type Mod = Record<string, unknown>
type Method = 'POST' | 'PUT' | 'DELETE'

const call = (mod: Mod, method: Method, path: string, token: string, body?: unknown,
  params: Record<string, string> = {}) =>
  (mod[method] as (r: Request, c: { params: Promise<Record<string, string>> }) => Promise<Response>)(
    new Request(`https://console.test/api/admin/v1${path}`, {
      method,
      headers: { ...bearer(token), ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    { params: Promise.resolve(params) },
  )

const GRAPH = { '4': { class_type: 'CLIPTextEncode', inputs: { text: '' } } }
const draft = (id: string) => ({
  id,
  graphText: JSON.stringify(GRAPH),
  params: [{ name: 'prompt', type: 'text', target: { node: '4', input: 'text' } }],
  cost: 1,
})

let db: TestDb
let adminUserId: string
let myOrgId: string

/** Ids of rows in the actor's own org (`mine`) and in another org (`foreign`). */
interface Ids {
  flockId: string; paddockId: string; comfyPaddockId: string; keyId: string
  foreignFlockId: string; foreignPaddockId: string; foreignComfyPaddockId: string
}
let ids: Ids

async function flockAndPaddock(orgId: string, breed: string, slug: string) {
  const [f] = await db.insert(flock).values({
    orgId, breed, name: `f-${slug}`, baseUrl: 'http://upstream:11434',
  }).returning()
  const [p] = await db.insert(paddock).values({ orgId, flockId: f.id, name: slug, slug }).returning()
  return { flockId: f.id, paddockId: p.id }
}

beforeEach(async () => {
  publish.mockClear()
  db = await freshDb()
  held.db = db
  const mine = await seedOrg(db)
  myOrgId = mine.id
  const [other] = await db.insert(org).values({ name: 'other' }).returning()
  const [u] = await db.insert(user).values({
    orgId: mine.id, email: 'admin@x.io', passwordHash: 'unused', role: 'admin', status: 'active',
  }).returning()
  adminUserId = u.id
  const ollama = await flockAndPaddock(mine.id, 'ollama', 'p-one')
  const comfy = await flockAndPaddock(mine.id, 'comfyui', 'p-comfy')
  const foreign = await flockAndPaddock(other.id, 'ollama', 'foreign')
  const foreignComfy = await flockAndPaddock(other.id, 'comfyui', 'foreign-comfy')
  // The key is made through the route with a full token, and the publish it causes is cleared, so
  // each case below counts only its own.
  const admin = await tok.mint({ sub: adminUserId })
  const res = await call(keys, 'POST', '/keys', admin, { name: 'k', paddockIds: [ollama.paddockId] })
  expect(res.status).toBe(201)
  const key = await res.json() as { id: string }
  publish.mockClear()
  ids = {
    flockId: ollama.flockId, paddockId: ollama.paddockId, comfyPaddockId: comfy.paddockId,
    keyId: key.id, foreignFlockId: foreign.flockId, foreignPaddockId: foreign.paddockId,
    foreignComfyPaddockId: foreignComfy.paddockId,
  }
})

interface Case {
  name: string
  mod: Mod
  method: Method
  /** The `publishConfigInvalidation` argument the matching console action passes. */
  reason: string
  path: (i: Ids) => string
  params: (i: Ids) => Record<string, string>
  body?: (i: Ids) => unknown
  /** The same request aimed at a row in another org, where the route has an id to aim with. */
  foreign?: (i: Ids) => Record<string, string>
}

// One row per mutating admin operation. `reason` is copied from the console action that performs
// the same service call — src/app/(app)/{flocks,keys,paddocks}/actions.ts and
// src/app/(app)/paddocks/[id]/{fence,templates}/actions.ts.
const CASES: Case[] = [
  { name: 'POST /flocks', mod: flocks, method: 'POST', reason: 'flock.save',
    path: () => '/flocks', params: () => ({}),
    body: () => ({ name: 'f2', breed: 'ollama', baseUrl: 'http://ollama:11434', tlsTrust: true }) },
  { name: 'PUT /flocks/{id}', mod: flockItem, method: 'PUT', reason: 'flock.save',
    path: (i) => `/flocks/${i.flockId}`, params: (i) => ({ id: i.flockId }),
    body: () => ({ name: 'renamed', breed: 'ollama', baseUrl: 'http://ollama:11434', tlsTrust: true }),
    foreign: (i) => ({ id: i.foreignFlockId }) },
  { name: 'DELETE /flocks/{id}', mod: flockItem, method: 'DELETE', reason: 'flock.delete',
    // A flock with no paddocks, so the delete is not refused for being in use.
    path: () => '/flocks/{new}', params: () => ({ id: '{new}' }),
    foreign: (i) => ({ id: i.foreignFlockId }) },
  { name: 'POST /keys', mod: keys, method: 'POST', reason: 'key.create',
    path: () => '/keys', params: () => ({}),
    body: (i) => ({ name: 'k2', paddockIds: [i.paddockId] }) },
  { name: 'POST /keys/{id}/revoke', mod: revokeRoute, method: 'POST', reason: 'key.revoke',
    path: (i) => `/keys/${i.keyId}/revoke`, params: (i) => ({ id: i.keyId }),
    foreign: () => ({ id: crypto.randomUUID() }) },
  { name: 'POST /paddocks', mod: paddocks, method: 'POST', reason: 'paddock.save',
    path: () => '/paddocks', params: () => ({}),
    body: (i) => ({ flockId: i.flockId, name: 'p2', slug: 'p-two' }) },
  { name: 'PUT /paddocks/{id}', mod: paddockItem, method: 'PUT', reason: 'paddock.save',
    path: (i) => `/paddocks/${i.paddockId}`, params: (i) => ({ id: i.paddockId }),
    body: (i) => ({ flockId: i.flockId, name: 'renamed', slug: 'p-one' }),
    foreign: (i) => ({ id: i.foreignPaddockId }) },
  { name: 'DELETE /paddocks/{id}', mod: paddockItem, method: 'DELETE', reason: 'paddock.delete',
    path: (i) => `/paddocks/${i.paddockId}`, params: (i) => ({ id: i.paddockId }),
    foreign: (i) => ({ id: i.foreignPaddockId }) },
  { name: 'PUT /paddocks/{id}/status', mod: statusRoute, method: 'PUT', reason: 'paddock.status',
    path: (i) => `/paddocks/${i.paddockId}/status`, params: (i) => ({ id: i.paddockId }),
    body: () => ({ status: 'disabled' }),
    foreign: (i) => ({ id: i.foreignPaddockId }) },
  { name: 'PUT /paddocks/{id}/fence', mod: fenceRoute, method: 'PUT', reason: 'fence.save',
    path: (i) => `/paddocks/${i.paddockId}/fence`, params: (i) => ({ id: i.paddockId }),
    body: () => ({ constraintJson: { allowedRoutes: ['chat'], allowedModels: ['llama3'] } }),
    foreign: (i) => ({ id: i.foreignPaddockId }) },
  { name: 'POST /paddocks/{id}/templates', mod: templates, method: 'POST', reason: 'template.save',
    path: (i) => `/paddocks/${i.comfyPaddockId}/templates`, params: (i) => ({ id: i.comfyPaddockId }),
    body: () => draft('txt2img'),
    foreign: (i) => ({ id: i.foreignComfyPaddockId }) },
  { name: 'PUT /paddocks/{id}/templates/{tid}', mod: templateItem, method: 'PUT', reason: 'template.save',
    path: (i) => `/paddocks/${i.comfyPaddockId}/templates/txt2img`,
    params: (i) => ({ id: i.comfyPaddockId, tid: 'txt2img' }),
    body: () => draft('txt2img'),
    foreign: (i) => ({ id: i.foreignComfyPaddockId, tid: 'txt2img' }) },
  { name: 'DELETE /paddocks/{id}/templates/{tid}', mod: templateItem, method: 'DELETE',
    reason: 'template.delete',
    path: (i) => `/paddocks/${i.comfyPaddockId}/templates/txt2img`,
    params: (i) => ({ id: i.comfyPaddockId, tid: 'txt2img' }),
    foreign: (i) => ({ id: i.foreignComfyPaddockId, tid: 'txt2img' }) },
]

/** The DELETE /flocks case needs a flock no paddock references; made on demand. */
async function resolve(c: Case, i: Ids) {
  let path = c.path(i)
  let params = c.params(i)
  if (path.includes('{new}')) {
    const [f] = await db.insert(flock).values({
      orgId: myOrgId, breed: 'ollama', name: 'spare',
      baseUrl: 'http://upstream:11434',
    }).returning()
    path = path.replace('{new}', f.id)
    params = { id: f.id }
  }
  return { path, params }
}

describe('admin mutations invalidate the data plane config cache, as the console does', () => {
  test('there is one case per mutating admin operation', () => {
    expect(CASES).toHaveLength(13)
  })

  test.each(CASES)('$name publishes $reason exactly once on success', async (c) => {
    const t = await tok.mint({ sub: adminUserId })
    const { path, params } = await resolve(c, ids)
    const res = await call(c.mod, c.method, path, t, c.body?.(ids), params)
    expect(res.status, await res.clone().text()).toBeLessThan(300)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith(c.reason)
  })

  test.each(CASES)('$name publishes nothing when refused with 403', async (c) => {
    const t = await tok.mint({ sub: adminUserId, scopes: ['read'] })
    const { path, params } = await resolve(c, ids)
    const res = await call(c.mod, c.method, path, t, c.body?.(ids), params)
    expect(res.status).toBe(403)
    expect(publish).not.toHaveBeenCalled()
  })

  test.each(CASES.filter((c) => c.foreign))('$name publishes nothing when refused with 404', async (c) => {
    const t = await tok.mint({ sub: adminUserId })
    const params = c.foreign!(ids)
    const res = await call(c.mod, c.method, c.path(ids), t, c.body?.(ids), params)
    expect(res.status).toBe(404)
    expect(publish).not.toHaveBeenCalled()
  })

  test.each([
    ['POST /flocks', flocks, '/flocks',
      () => ({ id: crypto.randomUUID(), name: 'f2', breed: 'ollama', baseUrl: 'http://o:1', tlsTrust: true })],
    ['POST /paddocks', paddocks, '/paddocks',
      () => ({ id: crypto.randomUUID(), flockId: ids.flockId, name: 'p2', slug: 'p-two' })],
    ['POST /keys (invalid body)', keys, '/keys', () => ({ name: '', paddockIds: [] })],
    ['PUT /paddocks/{id}/status (invalid body)', statusRoute, '/paddocks/x/status', () => ({ status: 'nope' })],
  ] as const)('%s publishes nothing when refused with 422', async (_n, mod, path, body) => {
    const t = await tok.mint({ sub: adminUserId })
    const params = mod === statusRoute ? { id: ids.paddockId } : {}
    const res = await call(mod as Mod, mod === statusRoute ? 'PUT' : 'POST', path, t, body(), params)
    expect(res.status).toBe(422)
    expect(publish).not.toHaveBeenCalled()
  })

  test('an unauthenticated mutation publishes nothing', async () => {
    const res = await (flocks.POST as unknown as (r: Request, c: { params: Promise<object> }) => Promise<Response>)(
      new Request('https://console.test/api/admin/v1/flocks', { method: 'POST', body: '{}' }),
      { params: Promise.resolve({}) },
    )
    expect(res.status).toBe(401)
    expect(publish).not.toHaveBeenCalled()
  })
})
