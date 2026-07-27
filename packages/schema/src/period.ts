export type QuotaWindow = 'hour' | 'day' | 'month'

/** UTC hour bucket, e.g. `2026-07-27T14`. The canonical `usage_rollup.period` format. */
export function periodBucket(atMs: number): string {
  const d = new Date(atMs)
  const y = d.getUTCFullYear()
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0')
  const da = String(d.getUTCDate()).padStart(2, '0')
  const h = String(d.getUTCHours()).padStart(2, '0')
  return `${y}-${mo}-${da}T${h}`
}

/** Prefix of the hour bucket used for `period LIKE prefix || '%'` quota range reads. */
export function periodPrefix(win: QuotaWindow, atMs: number): string {
  const bucket = periodBucket(atMs)
  if (win === 'hour') return bucket
  if (win === 'day') return bucket.slice(0, 10) // YYYY-MM-DD
  return bucket.slice(0, 7) // YYYY-MM
}
