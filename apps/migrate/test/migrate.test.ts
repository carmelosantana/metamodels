import { describe, expect, test } from 'vitest'
import { describeReseal, loadDatabaseUrl } from '../src/index'

describe('loadDatabaseUrl', () => {
  test('returns DATABASE_URL when set', () => {
    expect(loadDatabaseUrl({ DATABASE_URL: 'postgres://x/y' })).toBe('postgres://x/y')
  })

  test('throws when DATABASE_URL is missing', () => {
    expect(() => loadDatabaseUrl({})).toThrow('DATABASE_URL is required')
  })
})

describe('describeReseal', () => {
  test('is quiet about nothing and says what it sealed', () => {
    expect(describeReseal({ sealed: 0, resealed: 0, unreadable: [] })).toEqual({ info: [], warn: [] })
    expect(describeReseal({ sealed: 2, resealed: 1, unreadable: [] }).info)
      .toEqual(['metamodels: sealed 2 plaintext upstream credential(s); re-sealed 1 under the current key'])
  })

  test('names every unreadable flock, and how to recover it, without failing', () => {
    const { warn } = describeReseal({
      sealed: 0, resealed: 0,
      unreadable: [{ id: 'f-1', name: 'gpu box', reason: 'unknown-key' }],
    })
    expect(warn.join('\n')).toMatch(/f-1/)
    expect(warn.join('\n')).toMatch(/gpu box/)
    expect(warn.join('\n')).toMatch(/UPSTREAM_AUTH_PREVIOUS_KEYS/)
    expect(warn.join('\n')).toMatch(/re-enter/i)
  })
})
