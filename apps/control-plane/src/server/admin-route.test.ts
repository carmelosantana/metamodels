import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ForbiddenError, type Actor } from '../auth/authorize'
import { KeySetUnavailableError, TokenError } from './admin-token'
import { withAdmin, type AdminContext } from './admin-route'

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
