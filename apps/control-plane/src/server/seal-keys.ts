import { loadSealKeyring, type SealKeyring } from '@metamodels/schema/sealed'

let cached: SealKeyring | undefined

/**
 * The keyring that seals flock upstream credentials, read once from `UPSTREAM_AUTH_KEY` and
 * `UPSTREAM_AUTH_PREVIOUS_KEYS`. `instrumentation.ts` calls this at server boot and exits the process
 * with status 1 if it throws, so a bad key stops the console there. The lazy read is what lets
 * tests and scripts import services without one.
 */
export function upstreamAuthKeys(): SealKeyring {
  cached ??= loadSealKeyring(process.env)
  return cached
}
