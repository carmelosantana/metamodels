import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { auditLog, flock, org, user } from '@metamodels/schema'
import { freshDb, seedOrg, type TestDb } from '../test/db'
import { bearer, tokenFixture, type TokenFixture } from './test-token'
import * as collection from '../app/api/admin/v1/flocks/route'
import * as item from '../app/api/admin/v1/flocks/[id]/route'

// Both route modules import `getDb` from this very module id, so one mock covers both. The handlers
// resolve it per request, which is what lets a fresh PGlite be swapped in before each test.
const held = vi.hoisted(() => ({ db: undefined as unknown }))
vi.mock('./db', () => ({ getDb: () => held.db }))

let tok: TokenFixture
beforeAll(async () => { tok = await tokenFixture() })
afterAll(async () => { await tok.close() })

const url = (p: string) => `https://console.test/api/admin/v1${p}`

/** Calls a Route Handler directly — the handler IS the unit; no HTTP server needed. */
const call = (
  mod: Record<string, unknown>,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  token: string,
  body?: unknown,
  params: Record<string, string> = {},
) =>
  (mod[method] as (r: Request, c: { params: Promise<Record<string, string>> }) => Promise<Response>)(
    new Request(url(path), {
      method,
      headers: { ...bearer(token), ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
    { params: Promise.resolve(params) },
  )

/** Same as `call`, but the body goes on the wire verbatim — for bodies `JSON.stringify` cannot make. */
const rawCall = (
  mod: Record<string, unknown>,
  method: 'POST' | 'PUT',
  path: string,
  token: string,
  body: string,
  params: Record<string, string> = {},
) =>
  (mod[method] as (r: Request, c: { params: Promise<Record<string, string>> }) => Promise<Response>)(
    new Request(url(path), {
      method,
      headers: { ...bearer(token), 'content-type': 'application/json' },
      body,
    }),
    { params: Promise.resolve(params) },
  )

const FLOCK = { name: 'f1', breed: 'ollama', baseUrl: 'http://ollama:11434', tlsTrust: true }

let db: TestDb
let adminUserId: string
let viewerUserId: string
let otherOrgId: string

async function addUser(orgId: string, email: string, role: string): Promise<string> {
  const [u] = await db.insert(user).values({
    orgId, email, passwordHash: 'unused', role, status: 'active',
  }).returning()
  return u.id
}

/** A flock inserted straight into the given org — the only way to get a row this actor cannot see. */
async function createFlockIn(orgId: string) {
  const [f] = await db.insert(flock).values({
    orgId, breed: FLOCK.breed, name: 'foreign', baseUrl: FLOCK.baseUrl, tlsTrust: FLOCK.tlsTrust,
  }).returning()
  return f
}

beforeEach(async () => {
  db = await freshDb()
  held.db = db
  const mine = await seedOrg(db)
  const [other] = await db.insert(org).values({ name: 'other' }).returning()
  otherOrgId = other.id
  adminUserId = await addUser(mine.id, 'admin@x.io', 'admin')
  viewerUserId = await addUser(mine.id, 'viewer@x.io', 'viewer')
})

describe('/api/admin/v1/flocks', () => {
  test('GET returns a bare array and no Link on the last page', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const res = await call(collection, 'GET', '/flocks', t)
    expect(res.status).toBe(200)
    expect(Array.isArray(await res.json())).toBe(true)
    expect(res.headers.get('Link')).toBeNull()
  })

  test('GET ?limit= returns a page and a Link whose cursor resumes AFTER the last row', async () => {
    const t = await tok.mint({ sub: adminUserId })
    for (const name of ['a', 'b', 'c']) {
      await call(collection, 'POST', '/flocks', t, { ...FLOCK, name })
    }
    // Rows come back ordered by id, which is a random uuid — so insertion order proves nothing
    // and the expected page contents have to be read off an unpaginated GET.
    const ordered = await (await call(collection, 'GET', '/flocks', t)).json() as { id: string }[]
    expect(ordered).toHaveLength(3)

    const res = await call(collection, 'GET', '/flocks?limit=2', t)
    expect((await res.json() as { id: string }[]).map((f) => f.id)).toEqual([ordered[0].id, ordered[1].id])
    const link = res.headers.get('Link')
    expect(link).toMatch(/; rel="next"$/)

    // Three rows at limit=2, so the page is short of the last row and can only be reached by
    // following the header. A cursor built from the page's FIRST row instead of its last would
    // hand back row two again and loop a client forever — which a shape-only assertion on the
    // header cannot see, and which is the one line every later collection route copies verbatim.
    const next = new URL(link!.slice(1, link!.indexOf('>')))
    const page2 = await call(collection, 'GET', `/flocks${next.search}`, t)
    expect((await page2.json() as { id: string }[]).map((f) => f.id)).toEqual([ordered[2].id])
    expect(page2.headers.get('Link')).toBeNull()
  })

  test('POST creates, returns 201 and a Location header', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const res = await call(collection, 'POST', '/flocks', t, FLOCK)
    expect(res.status).toBe(201)
    const created = await res.json() as { id: string }
    expect(res.headers.get('location')).toBe(`/api/admin/v1/flocks/${created.id}`)
  })

  test('POST with an id in the body is 422', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const res = await call(collection, 'POST', '/flocks', t, { ...FLOCK, id: crypto.randomUUID() })
    expect(res.status).toBe(422)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
  })

  // A body defect is the caller's to fix. A 500 says the opposite, and says it with no detail.
  test.each([
    ['truncated JSON', '{"name":'],
    ['a JSON null', 'null'],
    ['a JSON array', '[{"name":"a"}]'],
    ['a JSON scalar', '"nope"'],
  ])('POST with %s is 422, never an opaque 500', async (_shape, raw) => {
    const t = await tok.mint({ sub: adminUserId })
    const res = await rawCall(collection, 'POST', '/flocks', t, raw)
    expect(res.status).toBe(422)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
  })

  test('PUT with a malformed body is 422, never an opaque 500', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const created = await (await call(collection, 'POST', '/flocks', t, FLOCK)).json() as { id: string }
    const res = await rawCall(item, 'PUT', `/flocks/${created.id}`, t, '{"name":', { id: created.id })
    expect(res.status).toBe(422)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
  })

  test('GET /{id} belonging to another org is 404 problem+json', async () => {
    const foreign = await createFlockIn(otherOrgId)
    const t = await tok.mint({ sub: adminUserId })
    const res = await call(item, 'GET', `/flocks/${foreign.id}`, t, undefined, { id: foreign.id })
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
  })

  test('PUT /{id} replaces every field', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const created = await (await call(collection, 'POST', '/flocks', t, FLOCK)).json() as { id: string }
    const res = await call(item, 'PUT', `/flocks/${created.id}`, t,
      { ...FLOCK, name: 'renamed', tlsTrust: false }, { id: created.id })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: created.id, name: 'renamed', tlsTrust: false })
  })

  test('PUT /{id} of another org 404s before it writes anything', async () => {
    const foreign = await createFlockIn(otherOrgId)
    const t = await tok.mint({ sub: adminUserId })
    const res = await call(item, 'PUT', `/flocks/${foreign.id}`, t,
      { ...FLOCK, name: 'hijacked' }, { id: foreign.id })
    expect(res.status).toBe(404)
    const after = await db.select().from(flock).where(eq(flock.id, foreign.id))
    expect(after[0].name).toBe('foreign')
  })

  test('DELETE /{id} is 204 and audits with changed_by = token:...', async () => {
    const t = await tok.mint({ sub: adminUserId, jti: 'jti-del' })
    const created = await (await call(collection, 'POST', '/flocks', t, FLOCK)).json() as { id: string }
    const res = await call(item, 'DELETE', `/flocks/${created.id}`, t, undefined, { id: created.id })
    expect(res.status).toBe(204)

    const rows = await db.select().from(auditLog)
    const entry = rows.find((r) => r.action === 'flock.delete')
    expect(entry?.changedBy).toBe('token:metamodels-cli:jti-del')
  })

  // The two cases the whole milestone exists for:

  test('a viewer-role token holding resource.write is 403 naming resource.write', async () => {
    const t = await tok.mint({ sub: viewerUserId, scopes: ['read', 'resource.write'] })
    const res = await call(collection, 'POST', '/flocks', t, FLOCK)
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ capability: 'resource.write' })
  })

  test('a token with no capability scopes is 403, not 200', async () => {
    const t = await tok.mint({ sub: adminUserId, scopes: [] })
    expect((await call(collection, 'GET', '/flocks', t)).status).toBe(403)
  })
})
