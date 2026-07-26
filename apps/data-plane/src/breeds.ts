import { BreedRegistry, comfyuiBreed, ollamaBreed } from '@metamodels/connectors'

export function buildRegistry(): BreedRegistry {
  const registry = new BreedRegistry()
  registry.register(ollamaBreed)
  registry.register(comfyuiBreed)
  return registry
}
