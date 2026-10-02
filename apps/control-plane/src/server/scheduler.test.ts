import { describe, expect, test } from 'vitest'
import { DEFAULT_HEALTH_INTERVAL_MS, DEFAULT_INTERVAL_MS, healthPassEnabled, resolveIntervalMs } from './scheduler'

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

describe('flock health cadence', () => {
  test('defaults to 5 minutes, through the same parser', () => {
    expect(DEFAULT_HEALTH_INTERVAL_MS).toBe(300_000)
    expect(resolveIntervalMs(undefined, DEFAULT_HEALTH_INTERVAL_MS)).toBe(300_000)
    expect(resolveIntervalMs('0', DEFAULT_HEALTH_INTERVAL_MS)).toBe(300_000)
    expect(resolveIntervalMs('60000', DEFAULT_HEALTH_INTERVAL_MS)).toBe(60_000)
  })
})

// An operator who bumps TAG on a pre-0.6.2 stack file gives the scheduler no UPSTREAM_AUTH_KEY. The
// license pass must keep running; only the health pass, which needs the key, stands down.
describe('healthPassEnabled', () => {
  test('on when UPSTREAM_AUTH_KEY is set, off (not a crash) when it is missing or blank', () => {
    expect(healthPassEnabled({ UPSTREAM_AUTH_KEY: 'k' })).toBe(true)
    expect(healthPassEnabled({})).toBe(false)
    expect(healthPassEnabled({ UPSTREAM_AUTH_KEY: '' })).toBe(false)
  })
})
