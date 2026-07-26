import { BreedRegistry, ollamaBreed } from '@metamodels/connectors'

export function buildRegistry(): BreedRegistry {
  const registry = new BreedRegistry()
  registry.register(ollamaBreed)
  return registry
}
