import { BreedRegistry, comfyuiBreed, ollamaBreed, type ModelListResult } from '@metamodels/connectors'
import type { Db } from './db'
import type { Actor } from '../auth/authorize'
import { getFlockConnection, NotFoundError } from './flocks-service'
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

/**
 * The console's Test for a saved flock: its health probe, run with what is STORED — URL, TLS
 * setting and the credential, opened here on the server. The id is the only input, so a caller
 * cannot point the stored credential at a URL of its choosing (the same rebind `saveFlock` refuses
 * with a 409), and only the probe's outcome goes back.
 */
export async function testStoredFlockConnection(
  registry: BreedRegistry,
  db: Db,
  actor: Actor,
  flockId: string,
): Promise<{ ok: boolean; detail?: string }> {
  let f
  try {
    f = await getFlockConnection(db, actor, flockId)
  } catch (e) {
    if (e instanceof NotFoundError) return { ok: false, detail: 'flock not found' }
    throw e
  }
  // Fail closed, as `listFlockModels` does: probing without it would report the upstream's 401.
  if (f.upstreamAuthError) return { ok: false, detail: 'upstream credential unavailable' }
  return registry.get(f.breed).health({ baseUrl: f.baseUrl, upstreamAuth: f.upstreamAuth, tlsTrust: f.tlsTrust })
}

export async function listFlockModels(
  registry: BreedRegistry,
  db: Db,
  actor: Actor,
  flockId: string,
): Promise<ModelListResult> {
  let f
  try {
    f = await getFlockConnection(db, actor, flockId)
  } catch (e) {
    if (e instanceof NotFoundError) return { ok: false, models: [], detail: 'flock not found' }
    throw e
  }
  const breed = registry.get(f.breed)
  if (!breed.listModels) return { ok: false, models: [], detail: 'unsupported' }
  // Fail closed, like the data plane: asking without the credential would come back as the
  // upstream's 401 and send the operator looking at the wrong system.
  if (f.upstreamAuthError) return { ok: false, models: [], detail: 'upstream credential unavailable' }
  return breed.listModels({ baseUrl: f.baseUrl, upstreamAuth: f.upstreamAuth, tlsTrust: f.tlsTrust })
}
