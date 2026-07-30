import { describe, expect, test } from 'vitest'
import { DEFAULT_INTERVAL_MS, resolveIntervalMs } from './scheduler'

describe('resolveIntervalMs', () => {
  test('defaults to 12h when unset', () => {
    expect(DEFAULT_INTERVAL_MS).toBe(43_200_000)
    expect(resolveIntervalMs(undefined)).toBe(DEFAULT_INTERVAL_MS)
    expect(resolveIntervalMs('')).toBe(DEFAULT_INTERVAL_MS)
  })

  test('uses a valid positive-integer override', () => {
    expect(resolveIntervalMs('3600000')).toBe(3_600_000)
  })

  test('falls back to the default for non-numeric or non-positive input', () => {
    expect(resolveIntervalMs('abc')).toBe(DEFAULT_INTERVAL_MS)
    expect(resolveIntervalMs('0')).toBe(DEFAULT_INTERVAL_MS)
    expect(resolveIntervalMs('-5')).toBe(DEFAULT_INTERVAL_MS)
    expect(resolveIntervalMs('1.5')).toBe(DEFAULT_INTERVAL_MS)
  })
})
