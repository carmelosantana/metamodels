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
})
