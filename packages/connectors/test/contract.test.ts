import { describe, expect, test } from 'vitest'
import type { RequestCtx, UpstreamResult } from '../src/breed.js'
import { echoBreed } from '../src/testing/echo-breed.js'

const ctx: RequestCtx = {
  method: 'POST', path: '/echo', headers: {}, body: { hi: 1 }, paddockSlug: 'p',
}

describe('Breed contract via echo', () => {
  test('guard allows when fence.allow is true', () => {
    const r = echoBreed.guard(ctx, { allow: true })
    expect(r).toEqual({ ok: true, request: { method: 'POST', path: '/echo', headers: {}, body: { hi: 1 } } })
  })

  test('guard denies when fence.allow is false', () => {
    const r = echoBreed.guard(ctx, { allow: false })
    expect(r).toEqual({ ok: false, status: 403, reason: 'not allowed' })
  })

  test('meter extracts tokens from upstream body', () => {
    const up: UpstreamResult = { status: 200, headers: {}, body: { tokens: 7 } }
    expect(echoBreed.meter(ctx, up)).toEqual([{ dim: 'tokens_out', value: 7, at: 0 }])
  })

  test('constraintSchema validates', () => {
    expect(echoBreed.constraintSchema.parse({})).toEqual({ allow: true })
  })
})
