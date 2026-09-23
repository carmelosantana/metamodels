import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { apiKey, auditLog, fence, flock, org, paddock, user } from '@metamodels/schema'
import { freshDb, seedOrg, type TestDb } from '../test/db'
import { bearer, tokenFixture, type TokenFixture } from './test-token'
import * as keys from '../app/api/admin/v1/keys/route'
import * as keyItem from '../app/api/admin/v1/keys/[id]/route'
import * as revokeRoute from '../app/api/admin/v1/keys/[id]/revoke/route'
import * as templates from '../app/api/admin/v1/paddocks/[id]/templates/route'
import * as templateItem from '../app/api/admin/v1/paddocks/[id]/templates/[tid]/route'

// All five route modules import `getDb` from this very module id, so one mock covers them all. The
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

/** A minimal comfyui graph plus the one param that points into it — what `validateDraft` accepts. */
const GRAPH = { '4': { class_type: 'CLIPTextEncode', inputs: { text: '' } } }
const draft = (id: string, cost = 1) => ({
  id,
  graphText: JSON.stringify(GRAPH),
  params: [{ name: 'prompt', type: 'text', target: { node: '4', input: 'text' } }],
  cost,
})

let db: TestDb
let adminUserId: string
let viewerUserId: string
let myPaddockId: string
let comfyPaddockId: string
let otherOrgId: string

async function addUser(orgId: string, email: string, role: string): Promise<string> {
  const [u] = await db.insert(user).values({
    orgId, email, passwordHash: 'unused', role, status: 'active',
  }).returning()
  return u.id
}

/** A flock + paddock inserted straight into an org — the only way to get rows this actor cannot see. */
async function paddockIn(orgId: string, breed: string, slug: string): Promise<string> {
  const [f] = await db.insert(flock).values({
    orgId, breed, name: `f-${slug}`, baseUrl: 'http://upstream:11434',
  }).returning()
  const [p] = await db.insert(paddock).values({ orgId, flockId: f.id, name: slug, slug }).returning()
  return p.id
}

beforeEach(async () => {
  db = await freshDb()
  held.db = db
  const mine = await seedOrg(db)
  const [other] = await db.insert(org).values({ name: 'other' }).returning()
  otherOrgId = other.id
  adminUserId = await addUser(mine.id, 'admin@x.io', 'admin')
  viewerUserId = await addUser(mine.id, 'viewer@x.io', 'viewer')
  myPaddockId = await paddockIn(mine.id, 'ollama', 'p-one')
  comfyPaddockId = await paddockIn(mine.id, 'comfyui', 'p-comfy')
})

/** POSTs a key through the collection route and returns the created representation. */
async function postKey(token: string, name = 'ci') {
  const res = await call(keys, 'POST', '/keys', token, { name, paddockIds: [myPaddockId] })
  expect(res.status).toBe(201)
  return await res.json() as { id: string; name: string; prefix: string; plaintext: string }
}

describe('/api/admin/v1/keys', () => {
  test('GET returns a bare array and no Link on the last page', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const res = await call(keys, 'GET', '/keys', t)
    expect(res.status).toBe(200)
    expect(Array.isArray(await res.json())).toBe(true)
    expect(res.headers.get('Link')).toBeNull()
  })

  test('GET ?limit= returns a page and a Link whose cursor resumes AFTER the last row', async () => {
    const t = await tok.mint({ sub: adminUserId })
    for (const n of ['a', 'b', 'c']) await postKey(t, n)
    // Rows come back ordered by id, which is a random uuid — so insertion order proves nothing
    // and the expected page contents have to be read off an unpaginated GET.
    const ordered = await (await call(keys, 'GET', '/keys', t)).json() as { id: string }[]
    expect(ordered).toHaveLength(3)

    const res = await call(keys, 'GET', '/keys?limit=2', t)
    expect((await res.json() as { id: string }[]).map((k) => k.id)).toEqual([ordered[0].id, ordered[1].id])
    const link = res.headers.get('Link')
    expect(link).toMatch(/; rel="next"$/)
    // Path-relative: `req.url` is the server's bind address behind a proxy, so no host may leak in.
    expect(link).toMatch(/^<\/api\/admin\/v1\/keys\?/)

    // Three rows at limit=2, so the page is short of the last row and can only be reached by
    // following the header. A cursor built from the page's FIRST row instead of its last would
    // hand back row two again and loop a client forever — which a shape-only assertion on the
    // header cannot see, and which is the one line every collection route copies verbatim.
    const next = new URL(link!.slice(1, link!.indexOf('>')), 'https://console.test')
    // The path as well as the cursor: only `next.search` is carried into the follow-up call below
    // (the `url()` helper re-prefixes the rest), so without this a `linkHeader` emitting the wrong
    // path would send every real client somewhere else and this test would never notice.
    expect(next.pathname).toBe('/api/admin/v1/keys')
    const page2 = await call(keys, 'GET', `/keys${next.search}`, t)
    expect((await page2.json() as { id: string }[]).map((k) => k.id)).toEqual([ordered[2].id])
    expect(page2.headers.get('Link')).toBeNull()
  })

  test('POST returns 201 with the plaintext, which GET never shows again', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const created = await postKey(t)
    expect(created.plaintext.startsWith('mm_live_')).toBe(true)
    expect(created.prefix).toBe(created.plaintext.slice(0, 12))

    // `createKey` hands the secret back exactly once and stores only a sha256 of it. If the list
    // representation ever grew a `plaintext` (or a `hash`, which is the secret's only preimage),
    // every operator with `read` would hold every key in the org.
    const listed = await (await call(keys, 'GET', '/keys', t)).text()
    // The POSITIVE anchor, and the reason the three negatives below mean anything. Every one of
    // them passes against `[]`, against a problem body, against the empty string — i.e. against a
    // listing that never contained this key at all, which would report the secret safely absent
    // from a response that was never the one under test. This is the most security-sensitive claim
    // in the suite; it must fail when the listing stops listing.
    expect(listed).toContain(created.id)
    expect(listed).not.toContain(created.plaintext)
    expect(listed).not.toContain('plaintext')
    const [row] = await db.select().from(apiKey).where(eq(apiKey.id, created.id))
    expect(listed).not.toContain(row.hash)
  })

  test('POST scoping a key to another org\'s paddock is 404 and writes nothing', async () => {
    const foreign = await paddockIn(otherOrgId, 'ollama', 'foreign')
    const t = await tok.mint({ sub: adminUserId })
    const res = await call(keys, 'POST', '/keys', t, { name: 'hijack', paddockIds: [foreign] })
    expect(res.status).toBe(404)
    expect(await db.select().from(apiKey)).toHaveLength(0)
  })

  // A body defect is the caller's to fix. A 500 says the opposite, and says it with no detail.
  test.each([
    ['truncated JSON', '{"name":'],
    ['a JSON null', 'null'],
    ['a JSON array', '[{"name":"a"}]'],
    ['a JSON scalar', '"nope"'],
  ])('POST /keys with %s is 422, never an opaque 500', async (_shape, raw) => {
    const t = await tok.mint({ sub: adminUserId })
    const res = await rawCall(keys, 'POST', '/keys', t, raw)
    expect(res.status).toBe(422)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
  })

  test('a viewer-role token holding resource.write is 403 naming resource.write', async () => {
    const t = await tok.mint({ sub: viewerUserId, scopes: ['read', 'resource.write'] })
    const res = await call(keys, 'POST', '/keys', t, { name: 'x', paddockIds: [myPaddockId] })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ capability: 'resource.write' })
    expect(await db.select().from(apiKey)).toHaveLength(0)
  })
})

describe('/api/admin/v1/keys/{id} — the refusal', () => {
  // Spec §2.1. DELETE means "gone" on flocks, paddocks and templates, which really do hard-delete.
  // A key cannot be hard-deleted (three usage_* tables cascade off key_id), and it must not quietly
  // mean "revoked" either — so the method is refused outright and the body names the alternative.
  test('DELETE is 405 and points at the revoke route', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const created = await postKey(t)
    const res = await call(keyItem, 'DELETE', `/keys/${created.id}`, t, undefined, { id: created.id })
    expect(res.status).toBe(405)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
    // RFC 9110 §15.5.6 makes `Allow` mandatory on a 405. Empty is the honest value — §10.2.1 reads
    // an empty field as "this resource allows no methods", which is exactly true of `/keys/{id}`.
    expect(res.headers.get('allow')).toBe('')
    expect(await res.json()).toMatchObject({
      status: 405,
      title: 'Method Not Allowed',
      detail: 'API keys are revoked, not deleted — POST /api/admin/v1/keys/{id}/revoke',
    })
  })

  test('DELETE neither deletes nor revokes, and audits nothing', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const created = await postKey(t)
    await call(keyItem, 'DELETE', `/keys/${created.id}`, t, undefined, { id: created.id })

    const rows = await db.select().from(apiKey).where(eq(apiKey.id, created.id))
    expect(rows).toHaveLength(1)
    // Not 'revoked' either: a 405 that quietly revoked would be the softer meaning this refusal exists
    // to prevent.
    expect(rows[0].status).toBe('active')
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'key.revoke'))).toHaveLength(0)
  })
})

describe('/api/admin/v1/keys/{id}/revoke', () => {
  test('POST is 204 and writes a key.revoke audit row with changed_by = token:...', async () => {
    const t = await tok.mint({ sub: adminUserId, jti: 'jti-rev' })
    const created = await postKey(t)
    const res = await call(revokeRoute, 'POST', `/keys/${created.id}/revoke`, t, undefined, { id: created.id })
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')

    const [row] = await db.select().from(apiKey).where(eq(apiKey.id, created.id))
    expect(row.status).toBe('revoked')

    const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'key.revoke'))
    expect(audits).toHaveLength(1)
    expect(audits[0].changedBy).toBe('token:metamodels-cli:jti-rev')
  })

  // Spec §3 (design doc line 194): "Revoking an already-revoked key is idempotent: 204, no second
  // audit entry." Both halves are asserted here because they are separable and were separately
  // wrong: the HTTP contract was already idempotent, the audit trail was not, and a replayed revoke
  // inflated the log with events that never happened.
  //
  // The 204 is the load-bearing half of this test now. `revokeKey` test-and-sets on
  // `status = 'active'`, so the second call matches no row — the shape that means 404 everywhere
  // else in this service. It must NOT mean 404 here: the key is revoked, which is exactly what the
  // caller asked for, and a 404 would send a client hunting for a key it just successfully retired.
  test('revoking an already-revoked key is 204 again and writes NO second audit row', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const created = await postKey(t)
    const first = await call(revokeRoute, 'POST', `/keys/${created.id}/revoke`, t, undefined, { id: created.id })
    expect(first.status).toBe(204)
    const second = await call(revokeRoute, 'POST', `/keys/${created.id}/revoke`, t, undefined, { id: created.id })
    expect(second.status).toBe(204)

    const [row] = await db.select().from(apiKey).where(eq(apiKey.id, created.id))
    expect(row.status).toBe('revoked')
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'key.revoke'))).toHaveLength(1)
  })

  // The no-op branch must not swallow the two cases a 404 exists for. Narrowing the UPDATE's
  // predicate makes "matched no row" ambiguous — already revoked, not ours, or never existed — and
  // collapsing those into one answer would let a caller probe another org's key ids by status.
  test('POST for a key id that never existed is 404, not a silent 204', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const ghost = crypto.randomUUID()
    const res = await call(revokeRoute, 'POST', `/keys/${ghost}/revoke`, t, undefined, { id: ghost })
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'key.revoke'))).toHaveLength(0)
  })

  test('POST for another org\'s key is 404 and leaves it active', async () => {
    const [foreignKey] = await db.insert(apiKey).values({
      orgId: otherOrgId, name: 'theirs', prefix: 'mm_live_aaaa', hash: 'h', status: 'active',
    }).returning()

    const t = await tok.mint({ sub: adminUserId })
    const res = await call(revokeRoute, 'POST', `/keys/${foreignKey.id}/revoke`, t, undefined, { id: foreignKey.id })
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
    const [row] = await db.select().from(apiKey).where(eq(apiKey.id, foreignKey.id))
    expect(row.status).toBe('active')
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'key.revoke'))).toHaveLength(0)
  })

  test('a viewer-role token holding resource.write is 403 naming resource.write', async () => {
    const admin = await tok.mint({ sub: adminUserId })
    const created = await postKey(admin)
    const t = await tok.mint({ sub: viewerUserId, scopes: ['read', 'resource.write'] })
    const res = await call(revokeRoute, 'POST', `/keys/${created.id}/revoke`, t, undefined, { id: created.id })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ capability: 'resource.write' })
    const [row] = await db.select().from(apiKey).where(eq(apiKey.id, created.id))
    expect(row.status).toBe('active')
  })
})

describe('/api/admin/v1/paddocks/{id}/templates', () => {
  test('GET on a comfyui paddock with no fence is an empty array', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const res = await call(templates, 'GET', `/paddocks/${comfyPaddockId}/templates`, t, undefined, { id: comfyPaddockId })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  test('POST then DELETE removes it from the returned array', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const post = await call(templates, 'POST', `/paddocks/${comfyPaddockId}/templates`, t,
      draft('txt2img'), { id: comfyPaddockId })
    expect(post.status).toBe(201)
    // `saveTemplate` returns the WHOLE array, not the one template — the 201 body is the collection.
    expect((await post.json() as { id: string }[]).map((x) => x.id)).toEqual(['txt2img'])

    const second = await call(templates, 'POST', `/paddocks/${comfyPaddockId}/templates`, t,
      draft('img2img'), { id: comfyPaddockId })
    expect((await second.json() as { id: string }[]).map((x) => x.id)).toEqual(['txt2img', 'img2img'])

    const del = await call(templateItem, 'DELETE', `/paddocks/${comfyPaddockId}/templates/txt2img`, t,
      undefined, { id: comfyPaddockId, tid: 'txt2img' })
    expect(del.status).toBe(204)

    const after = await call(templates, 'GET', `/paddocks/${comfyPaddockId}/templates`, t, undefined, { id: comfyPaddockId })
    expect((await after.json() as { id: string }[]).map((x) => x.id)).toEqual(['img2img'])
  })

  test('PUT /{tid} replaces that template, and the PATH owns the id', async () => {
    const t = await tok.mint({ sub: adminUserId })
    await call(templates, 'POST', `/paddocks/${comfyPaddockId}/templates`, t, draft('txt2img'), { id: comfyPaddockId })

    // The body's `id` says `somethingelse`; the path says `txt2img`. The path wins, so this is a
    // replace of txt2img and NOT a create of a second template.
    const res = await call(templateItem, 'PUT', `/paddocks/${comfyPaddockId}/templates/txt2img`, t,
      draft('somethingelse', 9), { id: comfyPaddockId, tid: 'txt2img' })
    expect(res.status).toBe(200)
    const arr = await res.json() as { id: string; cost: number }[]
    expect(arr.map((x) => x.id)).toEqual(['txt2img'])
    expect(arr[0].cost).toBe(9)
  })

  test('DELETE of an unknown template id is 204, audits anyway, and leaves the rest alone', async () => {
    const t = await tok.mint({ sub: adminUserId })
    await call(templates, 'POST', `/paddocks/${comfyPaddockId}/templates`, t, draft('txt2img'), { id: comfyPaddockId })
    const res = await call(templateItem, 'DELETE', `/paddocks/${comfyPaddockId}/templates/nope`, t,
      undefined, { id: comfyPaddockId, tid: 'nope' })
    expect(res.status).toBe(204)
    const after = await call(templates, 'GET', `/paddocks/${comfyPaddockId}/templates`, t, undefined, { id: comfyPaddockId })
    expect((await after.json() as { id: string }[]).map((x) => x.id)).toEqual(['txt2img'])

    // `deleteTemplate` filters and rewrites the column, then audits UNCONDITIONALLY — a no-op
    // delete still leaves a `template.delete` row naming an id that was never there. The route
    // comment asserts this in prose; asserted here so the prose cannot rot into a lie.
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'template.delete'))
    expect(audits).toHaveLength(1)
    expect(audits[0].detail).toMatchObject({ templateId: 'nope' })
  })

  // Every mutating handler in this resource crossed with every body shape `readJsonObject` exists
  // to catch: a bare `await req.json()` in either handler turns one of these into an opaque 500.
  // Flat rather than a loop inside one case, so a failure names the handler AND the shape.
  const MUTATORS = [
    ['POST /templates', templates, 'POST', '', {}],
    ['PUT /templates/{tid}', templateItem, 'PUT', '/txt2img', { tid: 'txt2img' }],
  ] as const
  const SHAPES = [
    ['truncated JSON', '{"name":'],
    ['a JSON null', 'null'],
    ['a JSON array', '[{"name":"a"}]'],
    ['a JSON scalar', '"nope"'],
  ] as const
  test.each(MUTATORS.flatMap(([name, mod, method, suffix, extra]) =>
    SHAPES.map(([shape, raw]) => [name, shape, mod, method, suffix, extra, raw] as const)))(
    '%s with %s is 422, never an opaque 500',
    async (_name, _shape, mod, method, suffix, extra, raw) => {
      const t = await tok.mint({ sub: adminUserId })
      const res = await rawCall(mod as unknown as Record<string, unknown>, method,
        `/paddocks/${comfyPaddockId}/templates${suffix}`, t, raw, { id: comfyPaddockId, ...extra })
      expect(res.status).toBe(422)
      expect(res.headers.get('content-type')).toBe('application/problem+json')
    })

  // ⚠ FINDING, pinned rather than fixed. `saveTemplate` rejects a bad draft with a plain
  // `new Error(reason)` — the same class a drizzle fault or a TypeError arrives as. `problemForError`
  // therefore cannot tell "your graph is malformed" from "the database fell over", and the brief
  // forbids widening the 500 arm into a catch-all 422, which would relabel genuine internal faults
  // as the caller's mistake. So a bad draft is an opaque 500 today, and this test says so out loud.
  // When `templates-service` grows a distinguishable error type, this flips to 422 and the arm goes
  // into `problemForError` — the assertion failing is the signal to do it.
  test('POST with an unbuildable draft is (today) an opaque 500, not a 422', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const res = await call(templates, 'POST', `/paddocks/${comfyPaddockId}/templates`, t,
      { ...draft('x'), params: [{ name: 'p', type: 'text', target: { node: 'NO-SUCH-NODE', input: 'text' } }] },
      { id: comfyPaddockId })
    expect(res.status).toBe(500)
    // No detail: an unmapped error's message is never echoed, so the caller learns nothing about
    // what was wrong with their draft. That is the cost of the missing error type.
    expect(await res.json()).toEqual({ type: 'about:blank', title: 'Internal Server Error', status: 500 })
  })

  test('GET for a non-comfyui paddock is 404', async () => {
    const t = await tok.mint({ sub: adminUserId })
    const res = await call(templates, 'GET', `/paddocks/${myPaddockId}/templates`, t, undefined, { id: myPaddockId })
    expect(res.status).toBe(404)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
  })

  test('POST for another org\'s paddock is 404 and writes no fence', async () => {
    const foreign = await paddockIn(otherOrgId, 'comfyui', 'foreign-comfy')
    const t = await tok.mint({ sub: adminUserId })
    const res = await call(templates, 'POST', `/paddocks/${foreign}/templates`, t, draft('x'), { id: foreign })
    expect(res.status).toBe(404)
    // `writeTemplates` UPSERTS a fence carrying `actor.orgId`. Were the org check not inside
    // `saveTemplate`'s transaction, this would have created a fence under THIS actor's org keyed on
    // another org's paddock.
    expect(await db.select().from(fence)).toHaveLength(0)
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'template.save'))).toHaveLength(0)
  })

  test('the template routes enforce resource.write', async () => {
    const admin = await tok.mint({ sub: adminUserId })
    await call(templates, 'POST', `/paddocks/${comfyPaddockId}/templates`, admin, draft('txt2img'), { id: comfyPaddockId })
    const t = await tok.mint({ sub: viewerUserId, scopes: ['read', 'resource.write'] })

    const post = await call(templates, 'POST', `/paddocks/${comfyPaddockId}/templates`, t, draft('b'), { id: comfyPaddockId })
    expect(post.status).toBe(403)
    expect(await post.json()).toMatchObject({ capability: 'resource.write' })

    const put = await call(templateItem, 'PUT', `/paddocks/${comfyPaddockId}/templates/txt2img`, t,
      draft('txt2img', 9), { id: comfyPaddockId, tid: 'txt2img' })
    expect(put.status).toBe(403)

    const del = await call(templateItem, 'DELETE', `/paddocks/${comfyPaddockId}/templates/txt2img`, t,
      undefined, { id: comfyPaddockId, tid: 'txt2img' })
    expect(del.status).toBe(403)

    // Nothing the viewer sent changed anything.
    const after = await call(templates, 'GET', `/paddocks/${comfyPaddockId}/templates`, admin, undefined, { id: comfyPaddockId })
    expect((await after.json() as { id: string; cost: number }[]).map((x) => x.id)).toEqual(['txt2img'])
  })
})
