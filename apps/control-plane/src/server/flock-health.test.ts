import { afterEach, describe, expect, test, vi } from 'vitest'
import { buildBreedRegistry, testFlockConnection } from './flock-health'

const registry = buildBreedRegistry()

afterEach(() => { vi.unstubAllGlobals() })

describe('testFlockConnection', () => {
  test('returns ok when the ollama upstream answers /api/version', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(String(url)).toBe('http://localhost:11434/api/version')
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await testFlockConnection(registry, {
      breed: 'ollama', baseUrl: 'http://localhost:11434/', tlsTrust: false,
    })
    expect(r.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  test('returns ok:false with detail when the upstream is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    const r = await testFlockConnection(registry, {
      breed: 'comfyui', baseUrl: 'http://localhost:8188', tlsTrust: false,
    })
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('ECONNREFUSED')
  })

  test('rejects an invalid breed before dispatching', async () => {
    await expect(testFlockConnection(registry, { breed: 'bogus', baseUrl: 'http://x', tlsTrust: false }))
      .rejects.toThrow()
  })
})
