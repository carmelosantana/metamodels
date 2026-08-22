import { describe, expect, test } from 'vitest'
import { partitionAllowlist, serializeAllowlist } from './model-allowlist'

describe('partitionAllowlist', () => {
  test('splits saved names into those present on the server and manual extras', () => {
    const r = partitionAllowlist(['llama3.1:8b', 'not-pulled:70b'], ['llama3.1:8b', 'qwen2.5-coder:0.5b'])
    expect(r).toEqual({ present: ['llama3.1:8b'], manual: ['not-pulled:70b'] })
  })
  test('empty saved ⇒ nothing selected', () => {
    expect(partitionAllowlist([], ['a', 'b'])).toEqual({ present: [], manual: [] })
  })
})

describe('serializeAllowlist', () => {
  test('comma-joins, trims, de-duplicates, drops blanks', () => {
    expect(serializeAllowlist(['a', ' a ', 'b', ''])).toBe('a, b')
  })
  test('empty selection ⇒ empty string (⇒ "any model" on save)', () => {
    expect(serializeAllowlist([])).toBe('')
  })
})
