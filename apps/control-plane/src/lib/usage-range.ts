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
