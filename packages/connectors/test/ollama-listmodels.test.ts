import { afterEach, describe, expect, test, vi } from 'vitest'
import { ollamaBreed } from '../src/ollama/index.js'

const flock = { baseUrl: 'http://ollama:11434', upstreamAuth: null, tlsTrust: false }

afterEach(() => vi.unstubAllGlobals())

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn(impl))
}

describe('ollamaBreed.listModels', () => {
  test('parses /api/tags into sorted, de-duplicated names', async () => {
    stubFetch(async (url) => {
      expect(url).toBe('http://ollama:11434/api/tags')
      return new Response(
        JSON.stringify({ models: [{ name: 'llama3.1:8b' }, { name: 'qwen2.5-coder:0.5b' }, { name: 'llama3.1:8b' }] }),
        { status: 200 },
      )
    })
    const r = await ollamaBreed.listModels!(flock)
    expect(r).toEqual({ ok: true, models: ['llama3.1:8b', 'qwen2.5-coder:0.5b'] })
  })

  test('sends Authorization when upstreamAuth is set', async () => {
    const seen: Record<string, string> = {}
    stubFetch(async (_url, init) => {
      Object.assign(seen, Object.fromEntries(new Headers(init?.headers).entries()))
      return new Response(JSON.stringify({ models: [] }), { status: 200 })
    })
    await ollamaBreed.listModels!({ ...flock, upstreamAuth: 'Bearer t0ken' })
    expect(seen['authorization']).toBe('Bearer t0ken')
  })

  test('returns ok:false (never throws) on a non-200', async () => {
    stubFetch(async () => new Response('nope', { status: 502 }))
    const r = await ollamaBreed.listModels!(flock)
    expect(r.ok).toBe(false)
    expect(r.models).toEqual([])
    expect(r.detail).toContain('502')
  })

  test('returns ok:false on a network error and on malformed JSON', async () => {
    stubFetch(async () => { throw new Error('ECONNREFUSED') })
    expect((await ollamaBreed.listModels!(flock)).ok).toBe(false)
    stubFetch(async () => new Response('<html>not json', { status: 200 }))
    const r = await ollamaBreed.listModels!(flock)
    expect(r.ok).toBe(false)
    expect(r.models).toEqual([])
  })
})
