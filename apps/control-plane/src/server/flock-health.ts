import { BreedRegistry, comfyuiBreed, ollamaBreed } from '@metamodels/connectors'
import { flockConnectionInput } from '../lib/flock-schema'

export function buildBreedRegistry(): BreedRegistry {
  const registry = new BreedRegistry()
  registry.register(ollamaBreed)
  registry.register(comfyuiBreed)
  return registry
}

export async function testFlockConnection(
  registry: BreedRegistry,
  input: unknown,
): Promise<{ ok: boolean; detail?: string }> {
  const data = flockConnectionInput.parse(input)
  const breed = registry.get(data.breed)
  return breed.health({
    baseUrl: data.baseUrl,
    upstreamAuth: data.upstreamAuth ?? null,
    tlsTrust: data.tlsTrust,
  })
}
