import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { auditLog, fence, flock, org, paddock, user } from '@metamodels/schema'
import { freshDb, seedOrg, type TestDb } from '../test/db'
import { bearer, tokenFixture, type TokenFixture } from './test-token'
import * as collection from '../app/api/admin/v1/paddocks/route'
import * as item from '../app/api/admin/v1/paddocks/[id]/route'
import * as statusRoute from '../app/api/admin/v1/paddocks/[id]/status/route'
import * as fenceRoute from '../app/api/admin/v1/paddocks/[id]/fence/route'

// All four route modules import `getDb` from this very module id, so one mock covers them all. The
// handlers resolve it per request, which is what lets a fresh PGlite be swapped in before each test.
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

/** A valid ollama fence constraint — the breed registry validates it on every save. */
const FENCE = { constraintJson: { allowedRoutes: ['chat'], allowedModels: ['llama3'] } }

let db: TestDb
let adminUserId: string
let viewerUserId: string
let myFlockId: string
let otherOrgId: string

async function addUser(orgId: string, email: string, role: string): Promise<string> {
  const [u] = await db.insert(user).values({
    orgId, email, passwordHash: 'unused', role, status: 'active',
  }).returning()
  return u.id
}

/** A flock + paddock inserted straight into an org — the only way to get rows this actor cannot see. */
async function createPaddockIn(orgId: string, slug = 'foreign-slug') {
  const [f] = await db.insert(flock).values({
    orgId, breed: 'ollama', name: 'foreign-flock', baseUrl: 'http://ollama:11434',
  }).returning()
  const [p] = await db.insert(paddock).values({
    orgId, flockId: f.id, name: 'foreign', slug,
  }).returning()
  return p
}

beforeEach(async () => {
  db = await freshDb()
  held.db = db
  const mine = await seedOrg(db)
  const [other] = await db.insert(org).values({ name: 'other' }).returning()
  otherOrgId = other.id
  adminUserId = await addUser(mine.id, 'admin@x.io', 'admin')
  viewerUserId = await addUser(mine.id, 'viewer@x.io', 'viewer')
  const [f] = await db.insert(flock).values({
    orgId: mine.id, breed: 'ollama', name: 'f1', baseUrl: 'http://ollama:11434',
  }).returning()
  myFlockId = f.id
})

/** A creatable paddock body. `flockId` is only known after `beforeEach`, hence the function. */
const PADDOCK = (slug = 'p-one') => ({ flockId: myFlockId, name: 'p1', slug })

/** POSTs a paddock through the collection route and returns the created row. */
async function post(token: string, slug = 'p-one') {
  const res = await call(collection, 'POST', '/paddocks', token, PADDOCK(slug))
  expect(res.status).toBe(201)
  return await res.json() as { id: string; slug: string; status: string }
}

describe('/api/admin/v1/paddocks', () => {
  test('GET returns a bare array and no Link on the last page', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const res = await call(collection, 'GET', '/paddocks', t)
    expect(res.status).toBe(200)
    expect(Array.isArray(await res.json())).toBe(true)
    expect(res.headers.get('Link')).toBeNull()
  })

  test('GET ?limit= returns a page and a Link whose cursor resumes AFTER the last row', async () => {
    const t = await tok.mint({ sub: adminUserId })
    for (const slug of ['a', 'b', 'c']) await post(t, slug)
    // Rows come back ordered by id, which is a random uuid — so insertion order proves nothing
    // and the expected page contents have to be read off an unpaginated GET.
    const ordered = await (await call(collection, 'GET', '/paddocks', t)).json() as { id: string }[]
    expect(ordered).toHaveLength(3)

    const res = await call(collection, 'GET', '/paddocks?limit=2', t)
    expect((await res.json() as { id: string }[]).map((p) => p.id)).toEqual([ordered[0].id, ordered[1].id])
    const link = res.headers.get('Link')
    expect(link).toMatch(/; rel="next"$/)
    // Path-relative: `req.url` is the server's bind address behind a proxy, so no host may leak in.
    expect(link).toMatch(/^<\/api\/admin\/v1\/paddocks\?/)

    // Three rows at limit=2, so the page is short of the last row and can only be reached by
    // following the header. A cursor built from the page's FIRST row instead of its last would
    // hand back row two again and loop a client forever — which a shape-only assertion on the
    // header cannot see, and which is the one line every collection route copies verbatim.
    const next = new URL(link!.slice(1, link!.indexOf('>')), 'https://console.test')
    const page2 = await call(collection, 'GET', `/paddocks${next.search}`, t)
    expect((await page2.json() as { id: string }[]).map((p) => p.id)).toEqual([ordered[2].id])
    expect(page2.headers.get('Link')).toBeNull()
  })

  test('POST creates, returns 201 and a Location header', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const res = await call(collection, 'POST', '/paddocks', t, PADDOCK())
    expect(res.status).toBe(201)
    const created = await res.json() as { id: string }
    expect(res.headers.get('location')).toBe(`/api/admin/v1/paddocks/${created.id}`)
  })

  // The slug is globally unique and `savePaddock` throws SlugTakenError for a collision.
  // `problemForError` maps it to 409; without that arm this would be an opaque 500.
  // `savePaddockInput` no longer defaults `status`, so the column default (`schema.ts:65`,
  // notNull().default('active')) is what makes a created paddock active. Pinned because the two
  // defaults are in different files and only one of them is still load-bearing.
  test('POST omitting status creates an active paddock', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const created = await post(t)
    expect(created.status).toBe('active')
    const [row] = await db.select().from(paddock).where(eq(paddock.id, created.id))
    expect(row.status).toBe('active')
  })

  test('POST with a slug already taken is 409 Conflict, never a 500', async () => {
    const t = await tok.mint({ sub: adminUserId })
    await post(t, 'taken')
    const res = await call(collection, 'POST', '/paddocks', t, PADDOCK('taken'))
    expect(res.status).toBe(409)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
  })

  test('POST with an id in the body is 422', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const res = await call(collection, 'POST', '/paddocks', t, { ...PADDOCK(), id: crypto.randomUUID() })
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
    const res = await rawCall(collection, 'POST', '/paddocks', t, raw)
    expect(res.status).toBe(422)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
  })

  // Every PUT in this resource, sub-resources included: a bare `await req.json()` in any one of
  // them turns a truncated body into an opaque 500.
  test.each([
    ['PUT /{id}', item, ''],
    ['PUT /{id}/status', statusRoute, '/status'],
    ['PUT /{id}/fence', fenceRoute, '/fence'],
  ] as const)('%s with a malformed body is 422, never an opaque 500', async (_name, mod, suffix) => {
    const t = await tok.mint({ sub: adminUserId })
    const created = await post(t)
    const res = await rawCall(mod, 'PUT', `/paddocks/${created.id}${suffix}`, t, '{"name":', { id: created.id })
    expect(res.status).toBe(422)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
  })

  test('GET /{id} belonging to another org is 404 problem+json', async () => {
    const foreign = await createPaddockIn(otherOrgId)
    const t = await tok.mint({ sub: adminUserId })
    const res = await call(item, 'GET', `/paddocks/${foreign.id}`, t, undefined, { id: foreign.id })
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
  })

  test('PUT /{id} replaces every field', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const created = await post(t)
    const res = await call(item, 'PUT', `/paddocks/${created.id}`, t,
      { ...PADDOCK('renamed-slug'), name: 'renamed', theme: 'metaboy' }, { id: created.id })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: created.id, name: 'renamed', slug: 'renamed-slug', theme: 'metaboy' })
  })

  // Spec §3: status is a PUT SUB-RESOURCE, not a field of the main PUT — a rename must not flip a
  // deliberately-thrown kill switch back on.
  //
  // The item PUT does NOT read the current status and carry it through. It `delete`s the field from
  // the body and `savePaddock` leaves the column out of its `set()` entirely, so the stored value is
  // untouched INSIDE the service's transaction. Do not "restore" a read-modify-write here: across
  // two transactions it would lose a concurrent PUT /{id}/status, which is the same re-enable
  // narrowed to a race window rather than removed. (`paddock-schema.ts:23` makes `status` optional
  // on `savePaddockInput` for the same reason — it no longer defaults to 'active'.)
  test('PUT /{id} omitting status leaves a disabled paddock disabled', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const created = await post(t)
    await call(statusRoute, 'PUT', `/paddocks/${created.id}/status`, t, { status: 'disabled' }, { id: created.id })
    const res = await call(item, 'PUT', `/paddocks/${created.id}`, t,
      { ...PADDOCK(), name: 'renamed' }, { id: created.id })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ name: 'renamed', status: 'disabled' })
    const [row] = await db.select().from(paddock).where(eq(paddock.id, created.id))
    expect(row.status).toBe('disabled')
  })

  // Ignored, not merely defaulted: `status` in the body must not be a second route to the switch.
  test('PUT /{id} sending status: active does NOT re-enable a disabled paddock', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const created = await post(t)
    await call(statusRoute, 'PUT', `/paddocks/${created.id}/status`, t, { status: 'disabled' }, { id: created.id })
    const res = await call(item, 'PUT', `/paddocks/${created.id}`, t,
      { ...PADDOCK(), name: 'renamed', status: 'active' }, { id: created.id })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'disabled' })
    const [row] = await db.select().from(paddock).where(eq(paddock.id, created.id))
    expect(row.status).toBe('disabled')
  })

  // The other direction, so preserving never becomes "always disabled".
  test('PUT /{id} leaves an active paddock active, even when the body says disabled', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const created = await post(t)
    const res = await call(item, 'PUT', `/paddocks/${created.id}`, t,
      { ...PADDOCK(), name: 'renamed', status: 'disabled' }, { id: created.id })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ name: 'renamed', status: 'active' })
    const [row] = await db.select().from(paddock).where(eq(paddock.id, created.id))
    expect(row.status).toBe('active')
  })

  test('PUT /{id} of another org 404s before it writes anything', async () => {
    const foreign = await createPaddockIn(otherOrgId)
    const t = await tok.mint({ sub: adminUserId })
    const res = await call(item, 'PUT', `/paddocks/${foreign.id}`, t,
      { ...PADDOCK('hijacked'), name: 'hijacked' }, { id: foreign.id })
    expect(res.status).toBe(404)
    const after = await db.select().from(paddock).where(eq(paddock.id, foreign.id))
    expect(after[0].name).toBe('foreign')
  })

  test('DELETE /{id} of another org is 404 and deletes nothing', async () => {
    const foreign = await createPaddockIn(otherOrgId)
    const t = await tok.mint({ sub: adminUserId })
    const res = await call(item, 'DELETE', `/paddocks/${foreign.id}`, t, undefined, { id: foreign.id })
    expect(res.status).toBe(404)
    expect(await db.select().from(paddock).where(eq(paddock.id, foreign.id))).toHaveLength(1)
  })

  test('DELETE /{id} is 204 and audits with changed_by = token:...', async () => {
    const t = await tok.mint({ sub: adminUserId, jti: 'jti-del' })
    const created = await post(t)
    const res = await call(item, 'DELETE', `/paddocks/${created.id}`, t, undefined, { id: created.id })
    expect(res.status).toBe(204)

    const rows = await db.select().from(auditLog)
    const entry = rows.find((r) => r.action === 'paddock.delete')
    expect(entry?.changedBy).toBe('token:metamodels-cli:jti-del')
  })
})

describe('/api/admin/v1/paddocks/{id}/status', () => {
  test('PUT flips to disabled and writes a paddock.status audit row', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const created = await post(t)
    expect(created.status).toBe('active')

    const res = await call(statusRoute, 'PUT', `/paddocks/${created.id}/status`, t,
      { status: 'disabled' }, { id: created.id })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: created.id, status: 'disabled' })

    const [row] = await db.select().from(paddock).where(eq(paddock.id, created.id))
    expect(row.status).toBe('disabled')

    // `paddock.status`, not `paddock.update` — the whole reason this is a separate sub-resource
    // routed at `setPaddockStatus` rather than a field of the main PUT.
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'paddock.status'))
    expect(audits).toHaveLength(1)
    expect(audits[0].detail).toMatchObject({ status: 'disabled' })
  })

  test('PUT rejects an unknown status with 422', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const created = await post(t)
    const res = await call(statusRoute, 'PUT', `/paddocks/${created.id}/status`, t,
      { status: 'paused' }, { id: created.id })
    expect(res.status).toBe(422)
    expect(res.headers.get('content-type')).toBe('application/problem+json')

    const [row] = await db.select().from(paddock).where(eq(paddock.id, created.id))
    expect(row.status).toBe('active')
  })

  test('PUT for another org paddock is 404 and leaves it untouched', async () => {
    const foreign = await createPaddockIn(otherOrgId)
    const t = await tok.mint({ sub: adminUserId })
    const res = await call(statusRoute, 'PUT', `/paddocks/${foreign.id}/status`, t,
      { status: 'disabled' }, { id: foreign.id })
    expect(res.status).toBe(404)
    const [row] = await db.select().from(paddock).where(eq(paddock.id, foreign.id))
    expect(row.status).toBe('active')
  })
})

describe('/api/admin/v1/paddocks/{id}/fence', () => {
  // "this paddock has no fence" and "there is no such paddock" are different failures with
  // different fixes, and they share a status code. The detail is the only thing separating them,
  // so both sides are asserted — here and in the foreign-org GET below.
  test('GET is 404 naming the FENCE when the paddock has no fence', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const created = await post(t)
    const res = await call(fenceRoute, 'GET', `/paddocks/${created.id}/fence`, t, undefined, { id: created.id })
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
    expect(await res.json()).toMatchObject({ detail: `fence for paddock ${created.id}` })
  })

  test('PUT saves and GET returns it', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const created = await post(t)
    const put = await call(fenceRoute, 'PUT', `/paddocks/${created.id}/fence`, t,
      { ...FENCE, rateLimit: { windowSec: 60, max: 30 } }, { id: created.id })
    expect(put.status).toBe(200)
    const saved = await put.json() as { id: string; paddockId: string }
    expect(saved.paddockId).toBe(created.id)

    const got = await call(fenceRoute, 'GET', `/paddocks/${created.id}/fence`, t, undefined, { id: created.id })
    expect(got.status).toBe(200)
    expect(await got.json()).toMatchObject({
      id: saved.id,
      paddockId: created.id,
      constraintJson: { allowedRoutes: ['chat'], allowedModels: ['llama3'] },
      rateLimit: { windowSec: 60, max: 30 },
    })
  })

  test('PUT rejects a constraint the breed does not allow with 422', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const created = await post(t)
    const res = await call(fenceRoute, 'PUT', `/paddocks/${created.id}/fence`, t,
      { constraintJson: { allowedRoutes: ['not-a-route'] } }, { id: created.id })
    expect(res.status).toBe(422)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
  })

  test('PUT for another org paddock is 404 and writes no fence', async () => {
    const foreign = await createPaddockIn(otherOrgId)
    const t = await tok.mint({ sub: adminUserId })
    const res = await call(fenceRoute, 'PUT', `/paddocks/${foreign.id}/fence`, t, FENCE, { id: foreign.id })
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
    // saveFence UPSERTS. Were the org check not inside its transaction, this would have created a
    // fence under THIS actor's org keyed on another org's paddock.
    expect(await db.select().from(fence)).toHaveLength(0)
  })

  test('GET for another org paddock is 404 naming the PADDOCK, not the fence', async () => {
    const foreign = await createPaddockIn(otherOrgId)
    const t = await tok.mint({ sub: adminUserId })
    const res = await call(fenceRoute, 'GET', `/paddocks/${foreign.id}/fence`, t, undefined, { id: foreign.id })
    expect(res.status).toBe(404)
    // `getFence` threw NotFoundError('paddock <id>') before it ever looked for a fence. If this
    // said "fence for paddock", a caller would go hunting for a missing fence on a paddock that
    // is not theirs and does not exist as far as they are concerned.
    // `NotFoundError`'s own message, which reads `not found: paddock <id>`.
    const body = await res.json() as { detail: string }
    expect(body.detail).toBe(`not found: paddock ${foreign.id}`)
    expect(body.detail).not.toContain('fence')
  })

  // I1: `saveFence` is a full replace for `rateLimit`/`quota` and a MERGE for `constraintJson`.
  // Both halves pinned, because neither was covered and a future service change to either would
  // have passed this suite silently — on the resource that IS the allow-list.
  test('PUT omitting constraintJson PRESERVES the stored constraint', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const created = await post(t)
    await call(fenceRoute, 'PUT', `/paddocks/${created.id}/fence`, t, FENCE, { id: created.id })

    const res = await call(fenceRoute, 'PUT', `/paddocks/${created.id}/fence`, t,
      { rateLimit: { windowSec: 30, max: 5 } }, { id: created.id })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ constraintJson: FENCE.constraintJson })

    const [row] = await db.select().from(fence).where(eq(fence.paddockId, created.id))
    expect(row.constraintJson).toMatchObject(FENCE.constraintJson)
    expect(row.rateLimit).toMatchObject({ windowSec: 30, max: 5 })
  })

  test('PUT omitting rateLimit CLEARS it', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const created = await post(t)
    // Asserted, not fired and forgotten. If this body ever stops validating, the setup 422s and no
    // fence row exists — the second PUT then CREATES one with rateLimit/quota already null, and
    // every assertion below passes VACUOUSLY without either field ever having been cleared.
    const setup = await call(fenceRoute, 'PUT', `/paddocks/${created.id}/fence`, t,
      { ...FENCE, rateLimit: { windowSec: 60, max: 30 }, quota: [{ dim: 'tokens_out', max: 1000, period: 'day' }] },
      { id: created.id })
    expect(setup.status).toBe(200)
    expect(await setup.json()).toMatchObject({
      rateLimit: { windowSec: 60, max: 30 },
      quota: [{ dim: 'tokens_out', max: 1000, period: 'day' }],
    })

    const res = await call(fenceRoute, 'PUT', `/paddocks/${created.id}/fence`, t, FENCE, { id: created.id })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ rateLimit: null, quota: null })

    const [row] = await db.select().from(fence).where(eq(fence.paddockId, created.id))
    expect(row.rateLimit).toBeNull()
    expect(row.quota).toBeNull()
  })
})

// The two cases the whole milestone exists for:
describe('/api/admin/v1/paddocks — the C3 intersection over HTTP', () => {
  test('a viewer-role token holding resource.write is 403 naming resource.write', async () => {
    const t = await tok.mint({ sub: viewerUserId, scopes: ['read', 'resource.write'] })
    const res = await call(collection, 'POST', '/paddocks', t, PADDOCK())
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ capability: 'resource.write' })
  })

  test('a token with no capability scopes is 403, not 200', async () => {
    const t = await tok.mint({ sub: adminUserId, scopes: [] })
    const res = await call(collection, 'GET', '/paddocks', t)
    expect(res.status).toBe(403)
    // The problem names the capability the token lacks, as M2 spec §7 asks of an unscoped token.
    expect(await res.json()).toMatchObject({ capability: 'read' })
  })

  test('the status and fence sub-resources enforce resource.write too', async () => {
    const admin = await tok.mint({ sub: adminUserId })
    const created = await post(admin)
    const t = await tok.mint({ sub: viewerUserId, scopes: ['read', 'resource.write'] })
    for (const [mod, path] of [[statusRoute, 'status'], [fenceRoute, 'fence']] as const) {
      const res = await call(mod, 'PUT', `/paddocks/${created.id}/${path}`, t,
        path === 'status' ? { status: 'disabled' } : FENCE, { id: created.id })
      expect(res.status).toBe(403)
      expect(await res.json()).toMatchObject({ capability: 'resource.write' })
    }
  })
})
