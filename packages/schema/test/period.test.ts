import { describe, expect, test } from 'vitest'
import { periodBucket, periodPrefix } from '../src/period.js'

const T = Date.UTC(2026, 6, 27, 14, 37, 5) // 2026-07-27T14:37:05Z (month is 0-based)

describe('periodBucket', () => {
  test('formats a UTC hour bucket YYYY-MM-DDTHH', () => {
    expect(periodBucket(T)).toBe('2026-07-27T14')
  })
  test('zero-pads single-digit month/day/hour', () => {
    expect(periodBucket(Date.UTC(2026, 0, 3, 5))).toBe('2026-01-03T05')
  })
})

describe('periodPrefix', () => {
  test('hour → full bucket', () => { expect(periodPrefix('hour', T)).toBe('2026-07-27T14') })
  test('day → date only', () => { expect(periodPrefix('day', T)).toBe('2026-07-27') })
  test('month → year-month', () => { expect(periodPrefix('month', T)).toBe('2026-07') })
})
