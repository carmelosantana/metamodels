import { describe, expect, test } from 'vitest'
import { DEFAULT_LIMIT, MAX_LIMIT, parsePageOpts, encodeCursor, decodeCursor, linkHeader } from './page'

const u = (qs: string) => new URL(`https://c.test/api/admin/v1/flocks${qs}`)

describe('parsePageOpts', () => {
  test('defaults the limit when absent', () => {
    expect(parsePageOpts(u('')).limit).toBe(DEFAULT_LIMIT)
  })
  test('clamps nothing — an over-max limit is rejected, not silently reduced', () => {
    expect(() => parsePageOpts(u(`?limit=${MAX_LIMIT + 1}`))).toThrow()
  })
  test('rejects a non-numeric or zero limit', () => {
    expect(() => parsePageOpts(u('?limit=abc'))).toThrow()
    expect(() => parsePageOpts(u('?limit=0'))).toThrow()
  })
})

describe('cursors', () => {
  test('round-trip', () => {
    const id = '11111111-2222-3333-4444-555555555555'
    expect(decodeCursor(encodeCursor(id))).toBe(id)
  })
  test('a malformed cursor is rejected, never coerced', () => {
    expect(() => decodeCursor('not-base64url!!')).toThrow()
    expect(() => decodeCursor(Buffer.from('not-a-uuid').toString('base64url'))).toThrow()
    expect(() => decodeCursor('')).toThrow()
  })
})

describe('linkHeader', () => {
  test('is absent on the last page', () => {
    expect(linkHeader(u(''), null)).toEqual({})
  })
  test('carries rel="next" with the cursor, preserving other query params', () => {
    const h = linkHeader(u('?limit=2'), 'CUR')
    expect(h.Link).toBe('<https://c.test/api/admin/v1/flocks?limit=2&cursor=CUR>; rel="next"')
  })
})
