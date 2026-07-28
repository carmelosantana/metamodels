import { describe, expect, test } from 'vitest'
import { resolveRange, isUsageRange } from './usage-range'

// 2026-07-28T14:30 UTC
const NOW = Date.UTC(2026, 6, 28, 14, 30, 0)

describe('resolveRange', () => {
  test('7d spans today back six days, endBucket is the current hour', () => {
    const r = resolveRange('7d', NOW)
    expect(r.endBucket).toBe('2026-07-28T14')
    expect(r.startBucket).toBe('2026-07-22T00')
    expect(r.days).toEqual([
      '2026-07-22', '2026-07-23', '2026-07-24', '2026-07-25', '2026-07-26', '2026-07-27', '2026-07-28',
    ])
  })

  test('24h is a single day (today)', () => {
    const r = resolveRange('24h', NOW)
    expect(r.days).toEqual(['2026-07-28'])
    expect(r.startBucket).toBe('2026-07-28T00')
    expect(r.endBucket).toBe('2026-07-28T14')
  })

  test('30d spans 30 day-prefixes ending today', () => {
    const r = resolveRange('30d', NOW)
    expect(r.days).toHaveLength(30)
    expect(r.days[0]).toBe('2026-06-29')
    expect(r.days[29]).toBe('2026-07-28')
  })

  test('isUsageRange guards the union', () => {
    expect(isUsageRange('7d')).toBe(true)
    expect(isUsageRange('year')).toBe(false)
  })
})
