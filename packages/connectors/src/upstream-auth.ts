import type { FlockRef } from './breed.js'

/**
 * The one place a flock's credential becomes a header. `upstreamAuth` is a bare token, sent as
 * `Authorization: Bearer <token>` on every call to the flock — the proxy, health probes, model
 * listing and raw uploads alike. No credential, no header.
 */
export function upstreamAuthHeaders(flock: Pick<FlockRef, 'upstreamAuth'>): Record<string, string> {
  return flock.upstreamAuth ? { authorization: `Bearer ${flock.upstreamAuth}` } : {}
}
