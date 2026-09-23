import { afterEach, describe, expect, test } from 'vitest'
import type { StoredCredential } from '../src/credentials.js'
import { ApiProblemError, callApi, formatProblem, type ApiSession } from '../src/client.js'
import { startStub, type Reply, type Stub } from './helpers/stub.js'

let stub: Stub | undefined
afterEach(async () => {
  await stub?.close()
  stub = undefined
})

function cred(accessToken: string): StoredCredential {
  return { issuer: 'http://op.test', resource: 'http://c.test/api/admin', scope: 'read', accessToken, accessExpiresAt: 0, refreshToken: 'rt-secret', obtainedAt: 0 }
}

/** A session holding at-1 that refreshes to at-2, counting refreshes. */
function session(): ApiSession & { refreshes: string[] } {
  let current = cred('at-1')
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
