import { periodBucket } from '@metamodels/schema'

export type UsageRange = '24h' | '7d' | '30d'

export interface ResolvedRange {
  startBucket: string
  endBucket: string
  days: string[] // 'YYYY-MM-DD', start day → today (UTC), inclusive
}

const DAYS: Record<UsageRange, number> = { '24h': 1, '7d': 7, '30d': 30 }
const DAY_MS = 24 * 60 * 60 * 1000

export function isUsageRange(v: string): v is UsageRange {
  return v === '24h' || v === '7d' || v === '30d'
}

const BUCKET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/

/**
 * Whether `v` is a `usage_rollup.period` bucket — the `YYYY-MM-DDTHH` UTC hour that `periodBucket`
 * mints. It lives here, beside `resolveRange`, because this module already owns the app's bucket
 * vocabulary and a second opinion about the format would be a second source of truth.
 *
 * The round-trip is doing real work a regex alone cannot: `2026-13-45T99` matches the shape, and
 * `Date.UTC` rolls it over to a real instant, so asking the function that MINTS buckets whether it
 * would ever mint this one is what rejects it — no new date arithmetic, no calendar table.
 *
 * Why the admin API validates at all, when `period` is a text column and a nonsense bucket merely
 * matches no row: an unvalidated range answers 200 with `[]`, telling a caller their org used
 * nothing in a window that was never a window. An empty report is a claim, and a report built on a
 * range the server could not parse should not make it.
 */
export function isBucket(v: string): boolean {
  const m = BUCKET.exec(v)
  if (!m) return false
  return periodBucket(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!)) === v
}

/** UTC day-prefix ('YYYY-MM-DD') of a millisecond timestamp. */
function dayPrefix(atMs: number): string {
  return periodBucket(atMs).slice(0, 10)
}

export function resolveRange(range: UsageRange, nowMs: number): ResolvedRange {
  const count = DAYS[range]
  const days: string[] = []
  for (let i = count - 1; i >= 0; i--) days.push(dayPrefix(nowMs - i * DAY_MS))
  return {
    startBucket: `${days[0]}T00`,
    endBucket: periodBucket(nowMs),
    days,
  }
}
