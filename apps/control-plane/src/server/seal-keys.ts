import { loadSealKeyring, type SealKeyring } from '@metamodels/schema/sealed'

let cached: SealKeyring | undefined

/**
 * The keyring that seals flock upstream credentials, read once from `UPSTREAM_AUTH_KEY` and
 * `UPSTREAM_AUTH_PREVIOUS_KEYS`. `instrumentation.ts` calls this at server boot, so a bad key stops
 * the console there; the lazy read is what lets tests and scripts import services without one.
 */
export function upstreamAuthKeys(): SealKeyring {
  cached ??= loadSealKeyring(process.env)
  return cached
}
