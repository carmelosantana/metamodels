/** Default revalidation cadence: 12 hours. The 7-day offline grace absorbs any missed pass. */
export const DEFAULT_INTERVAL_MS = 43_200_000

/** Parse the SCHEDULER_INTERVAL_MS override; fall back to the default for unset/blank/non-numeric/≤0. */
export function resolveIntervalMs(raw: string | undefined): number {
  if (!raw) return DEFAULT_INTERVAL_MS
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_INTERVAL_MS
  return n
}
