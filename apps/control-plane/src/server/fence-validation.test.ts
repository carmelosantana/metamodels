import { describe, expect, test } from 'vitest'
import { buildBreedRegistry } from './flock-health'
import { validateConstraintForBreed } from './fence-validation'

const registry = buildBreedRegistry()

describe('validateConstraintForBreed', () => {
  test('accepts a valid ollama constraint and applies defaults', () => {
    const out = validateConstraintForBreed(registry, 'ollama', { allowedRoutes: ['chat', 'read'] }) as {
      allowedRoutes: string[]; allowedModels: string[] | null
    }
    expect(out.allowedRoutes).toEqual(['chat', 'read'])
    expect(out.allowedModels).toBeNull() // default applied
  })

  test('rejects an ollama constraint that names a mutate route (mutate is not exposable)', () => {
    expect(() => validateConstraintForBreed(registry, 'ollama', { allowedRoutes: ['pull'] })).toThrow()
    expect(() => validateConstraintForBreed(registry, 'ollama', { allowedRoutes: [] })).toThrow() // min(1)
  })

  test('accepts a valid comfyui constraint (templates array, defaults to empty)', () => {
    const out = validateConstraintForBreed(registry, 'comfyui', {}) as { templates: unknown[] }
    expect(out.templates).toEqual([])
  })

  test('rejects an unknown breed', () => {
    expect(() => validateConstraintForBreed(registry, 'bogus', {})).toThrow()
  })
})
