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
    expect(describeReseal({ sealed: 0, resealed: 0, unreadable: [], vacuum: 'not-needed' })).toEqual({ info: [], warn: [] })
    expect(describeReseal({ sealed: 2, resealed: 1, unreadable: [], vacuum: 'done' }).info)
      .toEqual(['metamodels: sealed 2 plaintext upstream credential(s); re-sealed 1 under the current key'])
  })

  test('names every unreadable flock, and how to recover it, without failing', () => {
    const { warn } = describeReseal({
      sealed: 0, resealed: 0,
      unreadable: [{ id: 'f-1', name: 'gpu box', reason: 'unknown-key' }],
      vacuum: 'not-needed',
    })
    expect(warn.join('\n')).toMatch(/f-1/)
    expect(warn.join('\n')).toMatch(/gpu box/)
    expect(warn.join('\n')).toMatch(/UPSTREAM_AUTH_PREVIOUS_KEYS/)
    expect(warn.join('\n')).toMatch(/PUT \/api\/admin\/v1\/flocks\/f-1/)
  })
})

describe('describeReseal — a failed VACUUM', () => {
  test('warns with the exact command to run by hand, and the reason', () => {
    const { warn } = describeReseal({ sealed: 1, resealed: 0, unreadable: [], vacuum: { failed: 'lock timeout' } })
    expect(warn).toHaveLength(1)
    expect(warn[0]).toContain(`psql "$DATABASE_URL" -c 'VACUUM FULL "flock"'`)
    expect(warn[0]).toContain('lock timeout')
  })
})

describe('describeReseal — recovery advice depends on why a row will not open', () => {
  const one = (reason: 'unknown-key' | 'tampered' | 'malformed') =>
    describeReseal({ sealed: 0, resealed: 0, unreadable: [{ id: 'f-1', name: 'n', reason }], vacuum: 'not-needed' }).warn.join('\n')

  test('unknown-key: the key that sealed it may still exist, so offer both remedies', () => {
    expect(one('unknown-key')).toMatch(/UPSTREAM_AUTH_PREVIOUS_KEYS/)
  })

  test('tampered or malformed: no key will help, so only re-entering it does', () => {
    for (const reason of ['tampered', 'malformed'] as const) {
      const msg = one(reason)
      expect(msg).not.toMatch(/UPSTREAM_AUTH_PREVIOUS_KEYS/)
      expect(msg).toMatch(/PUT \/api\/admin\/v1\/flocks\/f-1/)
    }
  })
})
