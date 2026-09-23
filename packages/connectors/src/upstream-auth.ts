import type { FlockRef } from './breed.js'

/**
 * The one place a flock's credential becomes a header. `upstreamAuth` is a bare token, sent as
 * `Authorization: Bearer <token>` on every call to the flock — the proxy, health probes, model
 * listing and raw uploads alike. No credential, no header.
 *
 * Why one leading `Bearer ` is dropped: legacy rows written before `saveFlockInput` validated a bare
 * token may carry it, and the reseal pass seals them as they were. Dropping it here, at send time,
 * is the only normalisation — there is deliberately no second one in the migration — so such a row
 * goes upstream as `Bearer <token>`, not `Bearer Bearer <token>`. New writes cannot carry it.
 */
export function upstreamAuthHeaders(flock: Pick<FlockRef, 'upstreamAuth'>): Record<string, string> {
  const token = flock.upstreamAuth?.replace(/^bearer\s+/i, '')
  return token ? { authorization: `Bearer ${token}` } : {}
}
