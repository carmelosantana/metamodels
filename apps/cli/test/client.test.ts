import { afterEach, describe, expect, test } from 'vitest'
import type { StoredCredential } from '../src/credentials.js'
import { ApiProblemError, callApi, formatProblem, type ApiSession } from '../src/client.js'
import { SignInAgainError } from '../src/device.js'
import { startStub, type Reply, type Stub } from './helpers/stub.js'

let stub: Stub | undefined
afterEach(async () => {
  await stub?.close()
  stub = undefined
})

const HOUR_MS = 3_600_000

/** An access token good for another hour unless `over` says otherwise. */
function cred(accessToken: string, over: Partial<StoredCredential> = {}): StoredCredential {
  return {
    issuer: 'http://op.test', resource: 'http://c.test/api/admin', scope: 'read', accessToken,
    accessExpiresAt: Date.now() + HOUR_MS, refreshToken: 'rt-secret', obtainedAt: 0, ...over,
  }
}

/** A session holding at-1 (fresh unless `over` says otherwise) that refreshes to a fresh at-2, counting refreshes. */
function session(over: Partial<StoredCredential> = {}): ApiSession & { refreshes: string[] } {
  let current = cred('at-1', over)
  const refreshes: string[] = []
  return {
    refreshes,
    current: () => current,
    refresh: async (stale) => {
      refreshes.push(stale.accessToken)
      current = cred('at-2')
      return current
    },
  }
}

const unauthorized: Reply = {
  status: 401,
  headers: { 'content-type': 'application/problem+json', 'www-authenticate': 'Bearer' },
  json: { type: 'about:blank', title: 'Unauthorized', status: 401, detail: 'the presented access token was rejected' },
}

async function api(route: string, handler: (auth: string | undefined) => Reply) {
  stub = await startStub()
  stub.on(route, (req) => handler(req.headers.authorization))
  return stub
}

describe('callApi', () => {
  test('sends the access token as a Bearer header, and no cookie', async () => {
    const s = await api('GET /api/admin/v1/flocks', () => ({ status: 200, json: [{ id: 'f1' }] }))
    const res = await callApi(s.url, session(), { method: 'GET', path: '/flocks' })
    expect(res.body).toEqual([{ id: 'f1' }])
    const req = s.requests[0]
    expect(req.path).toBe('/api/admin/v1/flocks')
    expect(req.headers.authorization).toBe('Bearer at-1')
    expect(req.headers.cookie).toBeUndefined()
  })

  test('sends a JSON body and query parameters', async () => {
    const s = await api('POST /api/admin/v1/flocks', () => ({ status: 201, json: { id: 'f1' } }))
    await callApi(s.url, session(), { method: 'POST', path: '/flocks', query: { limit: '5', cursor: 'a b' }, body: { name: 'x' } })
    const req = s.requests[0]
    expect(req.path).toBe('/api/admin/v1/flocks?limit=5&cursor=a+b')
    expect(req.headers['content-type']).toBe('application/json')
    expect(JSON.parse(req.body)).toEqual({ name: 'x' })
  })

  test('a 401 triggers exactly one refresh and one retry, with the new token', async () => {
    const s = await api('GET /api/admin/v1/flocks', (auth) => auth === 'Bearer at-2' ? { status: 200, json: [] } : unauthorized)
    const sess = session()
    const res = await callApi(s.url, sess, { method: 'GET', path: '/flocks' })
    expect(res.status).toBe(200)
    expect(sess.refreshes).toEqual(['at-1'])
    expect(s.requests.map((r) => r.headers.authorization)).toEqual(['Bearer at-1', 'Bearer at-2'])
  })

  test('a second 401 surfaces the problem instead of looping, and never shows a token', async () => {
    const s = await api('GET /api/admin/v1/flocks', () => unauthorized)
    const sess = session()
    const err = await callApi(s.url, sess, { method: 'GET', path: '/flocks' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiProblemError)
    expect((err as ApiProblemError).status).toBe(401)
    expect((err as Error).message).toContain('the presented access token was rejected')
    expect(sess.refreshes).toHaveLength(1)
    expect(s.requests).toHaveLength(2)
    for (const secret of ['at-1', 'at-2', 'rt-secret']) expect((err as Error).message).not.toContain(secret)
  })

  test('an expired stored token is refreshed before sending: the API never sees it', async () => {
    const s = await api('GET /api/admin/v1/flocks', (auth) => auth === 'Bearer at-2' ? { status: 200, json: [] } : unauthorized)
    const sess = session({ accessExpiresAt: Date.now() - 1000 })
    const res = await callApi(s.url, sess, { method: 'GET', path: '/flocks' })
    expect(res.status).toBe(200)
    expect(sess.refreshes).toEqual(['at-1'])
    expect(s.requests.map((r) => r.headers.authorization)).toEqual(['Bearer at-2'])
  })

  test('a token within 30 seconds of expiring is refreshed first; one with longer left is sent as it is', async () => {
    const s = await api('GET /api/admin/v1/flocks', () => ({ status: 200, json: [] }))
    const soon = session({ accessExpiresAt: Date.now() + 29_000 })
    await callApi(s.url, soon, { method: 'GET', path: '/flocks' })
    expect(soon.refreshes).toEqual(['at-1'])
    const later = session({ accessExpiresAt: Date.now() + 60_000 })
    await callApi(s.url, later, { method: 'GET', path: '/flocks' })
    expect(later.refreshes).toEqual([])
    expect(s.requests.map((r) => r.headers.authorization)).toEqual(['Bearer at-2', 'Bearer at-1'])
  })

  test('a 401 after a refresh made before sending is surfaced, not refreshed again', async () => {
    const s = await api('GET /api/admin/v1/flocks', () => unauthorized)
    const sess = session({ accessExpiresAt: 0 })
    const err = await callApi(s.url, sess, { method: 'GET', path: '/flocks' }).catch((e: unknown) => e)
    expect((err as ApiProblemError).status).toBe(401)
    expect(sess.refreshes).toEqual(['at-1'])
    expect(s.requests.map((r) => r.headers.authorization)).toEqual(['Bearer at-2'])
  })

  test('a pre-send refresh that fails for a reason other than a refusal still sends a token that has not expired', async () => {
    const s = await api('GET /api/admin/v1/flocks', () => ({ status: 200, json: [] }))
    const sess = session({ accessExpiresAt: Date.now() + 10_000 })
    sess.refresh = async (stale) => {
      sess.refreshes.push(stale.accessToken)
      throw new Error('the sign-in could not be renewed: the authorization server answered HTTP 503')
    }
    const res = await callApi(s.url, sess, { method: 'GET', path: '/flocks' })
    expect(res.status).toBe(200)
    expect(sess.refreshes).toEqual(['at-1'])
    expect(s.requests.map((r) => r.headers.authorization)).toEqual(['Bearer at-1'])
  })

  test('a 401 to a token sent after a failed pre-send refresh surfaces that refresh error, and refreshes nothing more', async () => {
    const s = await api('GET /api/admin/v1/flocks', () => unauthorized)
    const sess = session({ accessExpiresAt: Date.now() + 10_000 })
    sess.refresh = async (stale) => {
      sess.refreshes.push(stale.accessToken)
      throw new Error('the sign-in could not be renewed: the authorization server answered HTTP 503')
    }
    await expect(callApi(s.url, sess, { method: 'GET', path: '/flocks' })).rejects.toThrow(/HTTP 503/)
    expect(sess.refreshes).toEqual(['at-1'])
    expect(s.requests.map((r) => r.headers.authorization)).toEqual(['Bearer at-1'])
  })

  test('a pre-send refresh that fails for any reason fails the call when the token has expired: nothing is sent', async () => {
    const s = await api('GET /api/admin/v1/flocks', () => unauthorized)
    const sess = session({ accessExpiresAt: Date.now() - 1000 })
    sess.refresh = async (stale) => {
      sess.refreshes.push(stale.accessToken)
      throw new Error('the sign-in could not be renewed: the authorization server answered HTTP 503')
    }
    await expect(callApi(s.url, sess, { method: 'GET', path: '/flocks' })).rejects.toThrow(/HTTP 503/)
    expect(sess.refreshes).toEqual(['at-1'])
    expect(s.requests).toHaveLength(0)
  })

  test('a pre-send refresh the OP refuses fails the call even when the token has time left', async () => {
    const s = await api('GET /api/admin/v1/flocks', () => ({ status: 200, json: [] }))
    const sess = session({ accessExpiresAt: Date.now() + 10_000 })
    sess.refresh = async (stale) => {
      sess.refreshes.push(stale.accessToken)
      throw new SignInAgainError('the sign-in could not be renewed (invalid_grant)')
    }
    await expect(callApi(s.url, sess, { method: 'GET', path: '/flocks' })).rejects.toBeInstanceOf(SignInAgainError)
    expect(s.requests).toHaveLength(0)
  })

  test('an expired token with no refresh token is sent as it is: the 401 path says to sign in again, as before', async () => {
    const s = await api('GET /api/admin/v1/flocks', () => unauthorized)
    const sess = session({ accessExpiresAt: 0, refreshToken: undefined })
    sess.refresh = async (stale) => {
      sess.refreshes.push(stale.accessToken)
      throw new Error('the stored sign-in cannot be renewed')
    }
    await expect(callApi(s.url, sess, { method: 'GET', path: '/flocks' })).rejects.toThrow(/cannot be renewed/)
    expect(sess.refreshes).toEqual(['at-1'])
    expect(s.requests.map((r) => r.headers.authorization)).toEqual(['Bearer at-1'])
  })

  test('a 204 is a null body', async () => {
    const s = await api('POST /api/admin/v1/keys/k1/revoke', () => ({ status: 204 }))
    const res = await callApi(s.url, session(), { method: 'POST', path: '/keys/k1/revoke' })
    expect(res).toEqual({ status: 204, body: null })
  })

  test('reads the next page\'s cursor from Link: rel="next"', async () => {
    const s = await api('GET /api/admin/v1/flocks', () => ({
      status: 200, json: [{ id: 'f1' }],
      headers: { link: '<http://c.test/api/admin/v1/flocks?limit=1&cursor=CUR%2B1>; rel="next"' },
    }))
    const res = await callApi(s.url, session(), { method: 'GET', path: '/flocks', query: { limit: '1' } })
    expect(res.next).toBe('CUR+1')
  })

  test('resolves a relative Link target against the request URL (RFC 8288 §3.1)', async () => {
    const s = await api('GET /api/admin/v1/flocks', () => ({
      status: 200, json: [{ id: 'f1' }],
      headers: { link: '</api/admin/v1/flocks?limit=1&cursor=REL%2B2>; rel="next"' },
    }))
    await expect(callApi(s.url, session(), { method: 'GET', path: '/flocks', query: { limit: '1' } }))
      .resolves.toMatchObject({ next: 'REL+2' })
  })

  test('does not follow a redirect', async () => {
    const s = await api('GET /api/admin/v1/flocks', () => ({ status: 302, headers: { location: 'http://elsewhere.test/' } }))
    await expect(callApi(s.url, session(), { method: 'GET', path: '/flocks' })).rejects.toThrow(/redirect/)
    expect(s.requests).toHaveLength(1)
  })

  test('a 403 names the missing capability', async () => {
    const s = await api('POST /api/admin/v1/flocks', () => ({
      status: 403, headers: { 'content-type': 'application/problem+json' },
      json: { type: 'about:blank', title: 'Forbidden', status: 403, detail: 'missing capability resource.write', capability: 'resource.write' },
    }))
    const err = await callApi(s.url, session(), { method: 'POST', path: '/flocks', body: {} }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiProblemError)
    expect((err as Error).message).toMatch(/403 Forbidden/)
    expect((err as Error).message).toContain('missing capability resource.write')
    expect((err as Error).message).toMatch(/capability: resource\.write/)
  })
})

describe('callApi: Retry-After', () => {
  const unavailable = (headers: Record<string, string>): Reply => ({
    status: 503, headers: { 'content-type': 'application/problem+json', ...headers },
    json: { type: 'about:blank', title: 'Service Unavailable', status: 503, detail: 'the signing keys could not be fetched' },
  })

  test('a 503 carrying Retry-After says when to retry', async () => {
    const s = await api('GET /api/admin/v1/flocks', () => unavailable({ 'retry-after': '30' }))
    const err = await callApi(s.url, session(), { method: 'GET', path: '/flocks' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiProblemError)
    expect((err as Error).message).toBe(
      '503 Service Unavailable: the signing keys could not be fetched\n  retry after: 30 seconds')
    expect(s.requests).toHaveLength(1)
  })

  test('an HTTP-date Retry-After is printed as given', async () => {
    const s = await api('GET /api/admin/v1/flocks', () => unavailable({ 'retry-after': 'Wed, 23 Sep 2026 07:28:00 GMT' }))
    const err = await callApi(s.url, session(), { method: 'GET', path: '/flocks' }).catch((e: unknown) => e)
    expect((err as Error).message).toMatch(/\n  retry after: Wed, 23 Sep 2026 07:28:00 GMT$/)
  })

  test('a 503 without Retry-After prints no retry line', async () => {
    const s = await api('GET /api/admin/v1/flocks', () => unavailable({}))
    const err = await callApi(s.url, session(), { method: 'GET', path: '/flocks' }).catch((e: unknown) => e)
    expect((err as Error).message).toBe('503 Service Unavailable: the signing keys could not be fetched')
  })
})

describe('formatProblem', () => {
  test('title, detail, capability and validation errors, one per line', () => {
    expect(formatProblem(422, {
      type: 'about:blank', title: 'Unprocessable Content', status: 422, detail: 'request failed validation',
      errors: [{ path: 'name', message: 'Required' }, { path: '', message: 'Bad' }],
    })).toBe([
      '422 Unprocessable Content: request failed validation',
      '  name: Required',
      '  (body): Bad',
    ].join('\n'))
    expect(formatProblem(403, { title: 'Forbidden', detail: 'nope', capability: 'resource.write' }))
      .toBe('403 Forbidden: nope\n  capability: resource.write (sign in again with it in --scope)')
  })

  test('a body that is not a problem document still yields the status', () => {
    expect(formatProblem(502, null)).toBe('502 Bad Gateway')
    expect(formatProblem(500, { title: 'Internal Server Error' })).toBe('500 Internal Server Error')
  })
})
