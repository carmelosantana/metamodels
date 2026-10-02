/** Default revalidation cadence: 12 hours. The 7-day offline grace absorbs any missed pass. */
export const DEFAULT_INTERVAL_MS = 43_200_000

/** Default flock health cadence: 5 minutes, so the Dashboard is never long out of date. */
export const DEFAULT_HEALTH_INTERVAL_MS = 300_000

/** Parse an interval override (`SCHEDULER_INTERVAL_MS`, `FLOCK_HEALTH_INTERVAL_MS`); fall back to `fallback` for unset/blank/non-numeric/≤0. */
export function resolveIntervalMs(raw: string | undefined, fallback = DEFAULT_INTERVAL_MS): number {
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) return fallback
  return n
}

/**
 * Whether the flock health pass can run: it opens each flock's stored credential, so it needs
 * UPSTREAM_AUTH_KEY. A stack file from before 0.6.2 does not give the scheduler one; that must cost
 * flock health, not the license pass, so a missing key turns the health pass off instead of crashing.
 */
export function healthPassEnabled(env: Record<string, string | undefined>): boolean {
  return Boolean(env.UPSTREAM_AUTH_KEY)
}
