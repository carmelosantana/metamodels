import { describe, expect, test } from 'vitest'
import { computeBlastRadius } from './blast-radius'

describe('computeBlastRadius', () => {
  test('ollama: exposes allowed routes + model allowlist, mutate always locked', () => {
    const br = computeBlastRadius(
      'ollama',
      { allowedRoutes: ['chat', 'read'], allowedModels: ['llama3'] },
      { windowSec: 60, max: 30 },
      [{ dim: 'tokens_out', max: 100000, period: 'day' }],
    )
    expect(br.breedId).toBe('ollama')
    expect(br.mutateLocked).toBe(true)
    expect(br.exposed).toEqual(['chat', 'read'])
    expect(br.models).toEqual(['llama3'])
    expect(br.templateCount).toBeNull()
    expect(br.rateLimit).toEqual({ windowSec: 60, max: 30 })
    expect(br.quota).toHaveLength(1)
  })

  test('ollama: null allowedModels means any model', () => {
    const br = computeBlastRadius('ollama', { allowedRoutes: ['chat'], allowedModels: null }, null, null)
    expect(br.models).toBe('any')
    expect(br.rateLimit).toBeNull()
    expect(br.quota).toEqual([])
  })

  test('comfyui: exposes template ids and a count', () => {
    const br = computeBlastRadius(
      'comfyui',
      { templates: [{ id: 'txt2img', graph: {}, params: [], cost: 1 }, { id: 'img2img', graph: {}, params: [], cost: 2 }] },
      null, null,
    )
    expect(br.exposed).toEqual(['txt2img', 'img2img'])
    expect(br.templateCount).toBe(2)
    expect(br.models).toBe('any')
  })

  test('tolerates empty / malformed constraint JSON without throwing', () => {
    const br = computeBlastRadius('ollama', {}, undefined, undefined)
    expect(br.exposed).toEqual([])
    expect(br.models).toBe('any')
    expect(br.mutateLocked).toBe(true)
  })
})
