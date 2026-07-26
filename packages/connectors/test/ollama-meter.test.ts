import { describe, expect, test } from 'vitest'
import { ollamaBreed } from '../src/ollama/index.js'
import type { RequestCtx, UpstreamResult } from '../src/breed.js'

const ctx: RequestCtx = { method: 'POST', path: '/api/chat', headers: {}, body: {}, paddockSlug: 'p' }
const up = (body: unknown, finalFrame?: unknown): UpstreamResult => ({ status: 200, headers: {}, body, finalFrame })

describe('ollamaBreed.meter', () => {
  test('extracts native counts from the final NDJSON frame', () => {
    const events = ollamaBreed.meter(ctx, up(undefined, { done: true, prompt_eval_count: 11, eval_count: 22 }))
    expect(events).toEqual([
      { dim: 'tokens_in', value: 11, at: expect.any(Number) },
      { dim: 'tokens_out', value: 22, at: expect.any(Number) },
    ])
  })

  test('extracts /v1 usage object counts', () => {
    const events = ollamaBreed.meter(ctx, up({ usage: { prompt_tokens: 7, completion_tokens: 0 } }))
    expect(events).toEqual([{ dim: 'tokens_in', value: 7, at: expect.any(Number) }])
  })

  test('emits nothing when counts are absent or zero (cache hit)', () => {
    expect(ollamaBreed.meter(ctx, up({ done: true }))).toEqual([])
    expect(ollamaBreed.meter(ctx, up(null, null))).toEqual([])
  })
})
