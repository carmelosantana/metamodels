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
