import { describe, expect, test } from 'vitest'
import { GET } from './route'

describe('GET /api/healthz', () => {
  test('returns 200 with a liveness body', async () => {
    const res = GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })
})
