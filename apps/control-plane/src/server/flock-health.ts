import { BreedRegistry, comfyuiBreed, ollamaBreed, type ModelListResult } from '@metamodels/connectors'
import type { Db } from './db'
import type { Actor } from '../auth/authorize'
import { listFlocks } from './flocks-service'
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

export async function listFlockModels(
  registry: BreedRegistry,
  db: Db,
  actor: Actor,
  flockId: string,
): Promise<ModelListResult> {
  const f = (await listFlocks(db, actor)).find((x) => x.id === flockId)
  if (!f) return { ok: false, models: [], detail: 'flock not found' }
  const breed = registry.get(f.breed)
  if (!breed.listModels) return { ok: false, models: [], detail: 'unsupported' }
  return breed.listModels({ baseUrl: f.baseUrl, upstreamAuth: f.upstreamAuth, tlsTrust: f.tlsTrust })
}
