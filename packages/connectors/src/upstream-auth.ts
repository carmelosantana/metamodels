import type { FlockRef } from './breed.js'

/**
 * The one place a flock's credential becomes a header. `upstreamAuth` is a bare token, sent as
 * `Authorization: Bearer <token>` on every call to the flock — the proxy, health probes, model
 * listing and raw uploads alike. No credential, no header.
 *
 * A value stored before that contract may already carry `Bearer `; one such prefix is dropped so it
 * goes upstream once, not twice. New values cannot carry it: the control plane rejects them.
 */
export function upstreamAuthHeaders(flock: Pick<FlockRef, 'upstreamAuth'>): Record<string, string> {
  const token = flock.upstreamAuth?.replace(/^bearer\s+/i, '')
  return token ? { authorization: `Bearer ${token}` } : {}
}
