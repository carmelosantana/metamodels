import { describe, expect, test } from 'vitest'
import { proxyToUpstream } from '../src/proxy/proxy.js'
import { createFakeOllama } from './helpers/fake-ollama.js'

const flock = { baseUrl: 'http://fake.ollama', upstreamAuth: null }
const fetchImpl = (() => {
  const app = createFakeOllama()
  return (url: string, init: RequestInit) => app.request(url, init)
})()

describe('proxyToUpstream', () => {
  test('streams the NDJSON body to the client unchanged', async () => {
    const { response } = await proxyToUpstream(flock, {
      method: 'POST', path: '/api/chat', headers: { 'content-type': 'application/json' },
      body: { model: 'llama3.2:1b', messages: [] },
    }, { fetchImpl })
    const text = await response.text()
    expect(text).toContain('"done":true')
    expect(text.split('\n').filter(Boolean).length).toBe(3)
  })

  test('captures the final NDJSON frame for metering', async () => {
    const { metering } = await proxyToUpstream(flock, {
      method: 'POST', path: '/api/chat', headers: { 'content-type': 'application/json' },
      body: { model: 'llama3.2:1b', messages: [] },
    }, { fetchImpl })
    const up = await metering
    expect(up.status).toBe(200)
    expect((up.finalFrame as { eval_count: number }).eval_count).toBe(22)
  })

  test('captures a single JSON object for non-streaming responses', async () => {
    const { metering } = await proxyToUpstream(flock, {
      method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' },
      body: { model: 'llama3.2:1b', stream: false },
    }, { fetchImpl })
    const up = await metering
    expect((up.body as { usage: { prompt_tokens: number } }).usage.prompt_tokens).toBe(7)
  })

  test('strips content-encoding/content-length from the client response', async () => {
    const fetchStub = () =>
      Promise.resolve(
        new Response('{"ok":true}', {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-encoding': 'gzip',
            'content-length': '999',
          },
        }),
      )
    const { response } = await proxyToUpstream(flock, {
      method: 'POST', path: '/api/chat', headers: { 'content-type': 'application/json' },
      body: { model: 'llama3.2:1b', messages: [] },
    }, { fetchImpl: fetchStub })
    expect(response.headers.get('content-encoding')).toBe(null)
    expect(response.headers.get('content-length')).toBe(null)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(await response.text()).toBe('{"ok":true}')
  })

  test('sends a string body verbatim without JSON re-encoding', async () => {
    let seen: unknown
    const fetchImpl = async (_url: string, init: RequestInit) => {
      seen = init.body
      return new Response('ok')
    }
    await proxyToUpstream(
      { baseUrl: 'http://u', upstreamAuth: null },
      { method: 'POST', path: '/x', headers: { 'content-type': 'text/plain' }, body: 'raw-body' },
      { fetchImpl },
    )
    expect(seen).toBe('raw-body')
  })

  test('does not overwrite a non-JSON content-type with application/json', async () => {
    let seenHeaders: Record<string, string> | undefined
    const fetchImpl = async (_url: string, init: RequestInit) => {
      seenHeaders = init.headers as Record<string, string>
      return new Response('ok')
    }
    await proxyToUpstream(
      { baseUrl: 'http://u', upstreamAuth: null },
      { method: 'POST', path: '/x', headers: { 'content-type': 'text/plain' }, body: 'raw-body' },
      { fetchImpl },
    )
    expect(seenHeaders?.['content-type']).toBe('text/plain')
  })

  test('meters usage from a /v1 SSE stream', async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":5,"total_tokens":12}}\n\n' +
      'data: [DONE]\n\n'
    const fetchStub = () =>
      Promise.resolve(new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    const { metering } = await proxyToUpstream(flock, {
      method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' },
      body: { model: 'llama3.2:1b', stream: true },
    }, { fetchImpl: fetchStub })
    const up = await metering
    expect((up.finalFrame as { usage: { prompt_tokens: number } }).usage.prompt_tokens).toBe(7)
  })
})
