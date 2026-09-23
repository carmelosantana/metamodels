import { loadSealKeyring, type SealKeyring } from '@metamodels/schema/sealed'

let cached: SealKeyring | undefined

/**
 * The keyring that seals flock upstream credentials, read from `UPSTREAM_AUTH_KEY` and
 * `UPSTREAM_AUTH_PREVIOUS_KEYS` on first use (like `licenseSecret()`), so the console still boots
 * to a clear error on the first credential it touches rather than not at all.
 */
export function upstreamAuthKeys(): SealKeyring {
  cached ??= loadSealKeyring(process.env)
  return cached
}
