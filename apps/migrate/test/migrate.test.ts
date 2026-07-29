import { describe, expect, test } from 'vitest'
import { loadDatabaseUrl } from '../src/index'

describe('loadDatabaseUrl', () => {
  test('returns DATABASE_URL when set', () => {
    expect(loadDatabaseUrl({ DATABASE_URL: 'postgres://x/y' })).toBe('postgres://x/y')
  })

  test('throws when DATABASE_URL is missing', () => {
    expect(() => loadDatabaseUrl({})).toThrow('DATABASE_URL is required')
  })
})
