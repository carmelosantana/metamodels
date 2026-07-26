import { describe, expect, test } from 'vitest'
import { extractTextFrames } from '../src/meter/extract.js'

describe('extractTextFrames', () => {
  test('NDJSON: returns the last frame and prefers the whole-body parse for body', () => {
    const buffer =
      '{"done":false,"message":{"content":"hi"}}\n' +
      '{"done":true,"eval_count":22}\n'
    const { body, finalFrame } = extractTextFrames(buffer)
    // Multi-line NDJSON is not itself valid JSON, so `whole` is undefined and
    // body falls back to finalFrame (the last parseable line).
    expect((finalFrame as { eval_count: number }).eval_count).toBe(22)
    expect((body as { eval_count: number }).eval_count).toBe(22)
    expect(body).toEqual(finalFrame)
  })

  test('SSE: strips `data:` and skips `[DONE]`, so finalFrame is the usage frame', () => {
    const buffer =
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":5,"total_tokens":12}}\n\n' +
      'data: [DONE]\n\n'
    const { finalFrame } = extractTextFrames(buffer)
    expect((finalFrame as { usage: { prompt_tokens: number } }).usage.prompt_tokens).toBe(7)
  })

  test('single JSON object: body is the whole parsed object', () => {
    const buffer = '{"usage":{"prompt_tokens":7,"completion_tokens":5}}'
    const { body, finalFrame } = extractTextFrames(buffer)
    expect((body as { usage: { prompt_tokens: number } }).usage.prompt_tokens).toBe(7)
    expect(body).toEqual(finalFrame)
  })
})
