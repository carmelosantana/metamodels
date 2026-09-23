import { afterEach, describe, expect, test, vi } from 'vitest'
import { comfyuiBreed, ollamaBreed } from '../src/index.js'
import type { FlockRef } from '../src/breed.js'

// One convention for every call a breed makes to its flock: `upstreamAuth` is a bare token,
// sent as `Authorization: Bearer <token>` — never verbatim, never re-prefixed.
afterEach(() => vi.unstubAllGlobals())

function captureAuth(body: unknown): { value: () => string | null } {
  let seen: string | null = null
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    seen = new Headers(init?.headers).get('authorization')
    return new Response(JSON.stringify(body), { status: 200 })
  }))
  return { value: () => seen }
}

const calls: Array<[string, (f: FlockRef) => Promise<unknown>, unknown]> = [
  ['ollama health', (f) => ollamaBreed.health(f), { version: '0.1' }],
  ['ollama listModels', (f) => ollamaBreed.listModels!(f), { models: [] }],
  ['comfyui health', (f) => comfyuiBreed.health(f), {}],
]

describe.each(calls)('%s', (_name, call, body) => {
  test('sends the stored token as `Bearer <token>`', async () => {
    const auth = captureAuth(body)
    await call({ baseUrl: 'http://up:1', upstreamAuth: 't0ken', tlsTrust: false })
    expect(auth.value()).toBe('Bearer t0ken')
  })

  test('sends no Authorization header when the flock has no credential', async () => {
    const auth = captureAuth(body)
    await call({ baseUrl: 'http://up:1', upstreamAuth: null, tlsTrust: false })
    expect(auth.value()).toBeNull()
  })
})
