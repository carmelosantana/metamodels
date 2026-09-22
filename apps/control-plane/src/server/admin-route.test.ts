import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ForbiddenError, type Actor } from '../auth/authorize'
import { KeySetUnavailableError, TokenError } from './admin-token'
import { withAdmin, type AdminContext } from './admin-route'
import * as flockItem from '../app/api/admin/v1/flocks/[id]/route'
import * as paddockItem from '../app/api/admin/v1/paddocks/[id]/route'
import * as paddockStatus from '../app/api/admin/v1/paddocks/[id]/status/route'
import * as paddockFence from '../app/api/admin/v1/paddocks/[id]/fence/route'
import * as templates from '../app/api/admin/v1/paddocks/[id]/templates/route'
import * as templateItem from '../app/api/admin/v1/paddocks/[id]/templates/[tid]/route'
import * as keyItem from '../app/api/admin/v1/keys/[id]/route'
import * as revokeRoute from '../app/api/admin/v1/keys/[id]/revoke/route'

const actorFromToken = vi.hoisted(() => vi.fn())
vi.mock('./admin-token', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./admin-token')>()),
  actorFromToken,
}))
// The wrapper reaches for a real pool the moment it verifies; the triage cases must never get there.
vi.mock('./db', () => ({ getDb: vi.fn(() => ({})) }))

const ACTOR: Actor = {
  id: 'u1', orgId: 'o1', email: 'a@b.test', role: 'admin', credential: 'token:cli:j1',
}

const call = (
  headers: Record<string, string>,
  handler: Parameters<typeof withAdmin>[0] = async () => new Response('ok'),
  params: Record<string, string> = {},
) =>
  withAdmin(handler)(
    new Request('https://console.test/api/admin/v1/flocks', { headers }),
    { params: Promise.resolve(params) },
  )

beforeEach(() => {
  actorFromToken.mockReset()
  actorFromToken.mockResolvedValue(ACTOR)
})

describe('withAdmin — authentication triage', () => {
  test('no credential at all is 401', async () => {
    const res = await call({})
    expect(res.status).toBe(401)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
  })

  test('a session cookie alone is 401, not a fallback', async () => {
    const res = await call({ cookie: 'mm_session=whatever' })
    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toMatchObject({ detail: expect.stringContaining('session') })
  })

  test('a bearer AND a session cookie is 400, before any verification', async () => {
    const res = await call({ authorization: 'Bearer x.y.z', cookie: 'mm_session=whatever' })
    expect(res.status).toBe(400)
    expect(actorFromToken).not.toHaveBeenCalled()
  })

  test('an unrelated cookie alongside a bearer is not a session and proceeds', async () => {
    const res = await call({ authorization: 'Bearer x.y.z', cookie: 'not_mm_session=1; theme=dark' })
    expect(res.status).toBe(200)
  })

  test('a malformed Authorization header is 401', async () => {
    expect((await call({ authorization: 'Basic abc' })).status).toBe(401)
    expect(actorFromToken).not.toHaveBeenCalled()
  })

  // RFC 9110 §11.1: the auth scheme token is case-insensitive. A conforming SDK sending a
  // lowercase scheme must not be turned away from this API's only authentication surface.
  test('the Bearer scheme is matched case-insensitively', async () => {
    const res = await call({ authorization: 'bearer x.y.z' })
    expect(res.status).toBe(200)
    expect(actorFromToken).toHaveBeenCalledWith(expect.anything(), 'x.y.z')
  })

  test('extra whitespace after the scheme is not captured into the token', async () => {
    const res = await call({ authorization: 'Bearer   x.y.z' })
    expect(res.status).toBe(200)
    expect(actorFromToken).toHaveBeenCalledWith(expect.anything(), 'x.y.z')
  })

  test('the no-credential 401 carries a bare Bearer challenge', async () => {
    const res = await call({})
    expect(res.headers.get('www-authenticate')).toBe('Bearer')
    expect(res.headers.get('www-authenticate')).not.toContain('error')
  })

  test('a valid bearer with no cookie reaches the handler with the actor and params', async () => {
    const handler = vi.fn(async (_ctx: AdminContext) => new Response('ok'))
    const res = await call({ authorization: 'Bearer x.y.z' }, handler, { id: 'f1' })
    expect(res.status).toBe(200)
    expect(actorFromToken).toHaveBeenCalledWith(expect.anything(), 'x.y.z')
    expect(handler.mock.calls[0]![0]).toMatchObject({ actor: ACTOR, params: { id: 'f1' } })
  })
})

describe('withAdmin — errors become problems', () => {
  test('a rejected token is 401 with no reason echoed', async () => {
    actorFromToken.mockRejectedValue(new TokenError('subject is not an active user'))
    const res = await call({ authorization: 'Bearer x.y.z' })
    expect(res.status).toBe(401)
    expect(await res.text()).not.toContain('active user')
  })

  test('an unreachable key set is 503, not 401', async () => {
    actorFromToken.mockRejectedValue(new KeySetUnavailableError('timed out fetching the key set'))
    const res = await call({ authorization: 'Bearer x.y.z' })
    expect(res.status).toBe(503)
    expect(res.headers.get('retry-after')).toBe('30')
  })

  test('a throw from the handler is mapped, not propagated', async () => {
    const res = await call({ authorization: 'Bearer x.y.z' }, async () => {
      throw new ForbiddenError('user.manage')
    })
    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({ capability: 'user.manage' })
  })
})

/**
 * Cross-cutting, and here rather than in the per-resource suites for the same reason `withAdmin`
 * is: the defect is one a NEW `[id]` route inherits by default, so the test has to name every
 * route module at once and fail when one is added without the guard.
 *
 * `actorFromToken` and `getDb` are already mocked above, so a handler that fails to parse the path
 * id reaches a fake `{}` database and throws a `TypeError` — which `problemForError` maps to an
 * opaque 500. That IS the production defect in miniature: in production the same unparsed value
 * reaches Postgres, which rejects it as an invalid uuid literal, with the same unmappable result.
 */
const GARBAGE = 'my-flock'
const AUTH = { authorization: 'Bearer x.y.z', 'content-type': 'application/json' }

const callRoute = (
  mod: Record<string, unknown>,
  method: string,
  params: Record<string, string>,
  body?: unknown,
) =>
  (mod[method] as (r: Request, c: { params: Promise<Record<string, string>> }) => Promise<Response>)(
    new Request('https://console.test/api/admin/v1/x', {
      method,
      headers: AUTH,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve(params) },
  )

describe('a malformed path id is 422, never an opaque 500', () => {
  // Bodies are deliberately VALID where a handler reads one, so the only thing wrong with each
  // request is its path. A `{}` body on the status route would 422 on the body instead and this
  // table would pass green against a route that never looked at its id.
  const CASES = [
    ['GET /flocks/{id}', flockItem, 'GET', { id: GARBAGE }, undefined],
    ['PUT /flocks/{id}', flockItem, 'PUT', { id: GARBAGE }, { name: 'n', breed: 'ollama', baseUrl: 'http://u' }],
    ['DELETE /flocks/{id}', flockItem, 'DELETE', { id: GARBAGE }, undefined],
    ['GET /paddocks/{id}', paddockItem, 'GET', { id: GARBAGE }, undefined],
    ['PUT /paddocks/{id}', paddockItem, 'PUT', { id: GARBAGE }, { name: 'n', slug: 's' }],
    ['DELETE /paddocks/{id}', paddockItem, 'DELETE', { id: GARBAGE }, undefined],
    ['PUT /paddocks/{id}/status', paddockStatus, 'PUT', { id: GARBAGE }, { status: 'active' }],
    ['GET /paddocks/{id}/fence', paddockFence, 'GET', { id: GARBAGE }, undefined],
    ['PUT /paddocks/{id}/fence', paddockFence, 'PUT', { id: GARBAGE }, { rateLimit: null, quota: null }],
    ['GET /paddocks/{id}/templates', templates, 'GET', { id: GARBAGE }, undefined],
    ['POST /paddocks/{id}/templates', templates, 'POST', { id: GARBAGE }, { id: 't', graphText: '{}', params: [], cost: 0 }],
    ['PUT /paddocks/{id}/templates/{tid}', templateItem, 'PUT', { id: GARBAGE, tid: 'txt2img' }, { graphText: '{}', params: [], cost: 0 }],
    ['DELETE /paddocks/{id}/templates/{tid}', templateItem, 'DELETE', { id: GARBAGE, tid: 'txt2img' }, undefined],
    ['POST /keys/{id}/revoke', revokeRoute, 'POST', { id: GARBAGE }, undefined],
  ] as const

  test.each(CASES)('%s', async (_name, mod, method, params, body) => {
    const res = await callRoute(mod as unknown as Record<string, unknown>, method, params, body)
    expect(res.status).toBe(422)
    expect(res.headers.get('content-type')).toBe('application/problem+json')
    // The POSITIVE anchor. A 422 alone is also what a rejected BODY produces, so without this the
    // table would pass against a handler that never looked at its path at all — which is precisely
    // the bug under test. Only the path-id parser puts `id` in `errors[].path`.
    const p = await res.json() as { status: number; errors?: { path: string }[] }
    expect(p.status).toBe(422)
    expect(p.errors?.map((e) => e.path)).toContain('id')
  })

  // `{tid}` is NOT a uuid and must not be parsed as one: `saveTemplate` keys on the draft's own id
  // (`txt2img`, `img2img`), which lives inside a JSON column and never reaches a uuid cast. A
  // helper applied indiscriminately to every path segment would 422 every template call there is.
  test('a non-uuid {tid} is untouched — only {id} is a uuid', async () => {
    const res = await callRoute(templateItem, 'DELETE', { id: crypto.randomUUID(), tid: 'txt2img' })
    expect(res.status).not.toBe(422)
  })

  // A method refusal does not depend on the id: `DELETE /keys/{id}` touches no database, reads no
  // params and answers on the method alone (spec §2.1). Parsing the id first here would turn a
  // fixed, publishable contract into one that varies with the caller's input.
  test('DELETE /keys/{id} is still 405 with a malformed id', async () => {
    const res = await callRoute(keyItem, 'DELETE', { id: GARBAGE })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('')
    expect(await res.json()).toMatchObject({ status: 405, title: 'Method Not Allowed' })
  })
})
