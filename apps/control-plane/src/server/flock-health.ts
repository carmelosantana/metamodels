import { BreedRegistry, comfyuiBreed, ollamaBreed, upstreamAuthHeaders, type ModelListResult } from '@metamodels/connectors'
import type { Db } from './db'
import type { Actor } from '../auth/authorize'
import { getFlockConnection, NotFoundError } from './flocks-service'
import { flockConnectionInput, UPSTREAM_AUTH_PATTERN } from '../lib/flock-schema'
import { uuidSchema } from './path-id'

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
  // A server action is an endpoint anyone signed in can post to. A non-uuid id names no flock, and
  // would otherwise reach Postgres as an invalid uuid literal and come back as a driver error.
  if (!uuidSchema.safeParse(flockId).success) return { ok: false, detail: 'flock not found' }
  let f
  try {
    f = await getFlockConnection(db, actor, flockId)
  } catch (e) {
    if (e instanceof NotFoundError) return { ok: false, detail: 'flock not found' }
    throw e
  }
  // Fail closed, as `listFlockModels` does: probing without it would report the upstream's 401.
  if (f.upstreamAuthError) return { ok: false, detail: 'upstream credential unavailable' }
  // The token as it goes on the wire: a legacy leading `Bearer ` is dropped by the same helper.
  const token = upstreamAuthHeaders(f).authorization?.slice('Bearer '.length)
  // A row sealed before bare tokens were validated can hold a value no header may carry, and the
  // error fetch raises for an illegal header quotes it. Refuse it here instead.
  if (token !== undefined && !UPSTREAM_AUTH_PATTERN.test(token)) {
    return { ok: false, detail: 'the stored credential is not a valid bearer token; replace it' }
  }
  const r = await registry.get(f.breed).health({ baseUrl: f.baseUrl, upstreamAuth: f.upstreamAuth, tlsTrust: f.tlsTrust })
  // `detail` is the client's error text, which goes to the browser. Never let it carry the token.
  if (token && r.detail?.includes(token)) return { ok: r.ok, detail: 'the request to the flock failed' }
  return r
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
