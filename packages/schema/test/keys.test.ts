import { describe, expect, test } from 'vitest'
import { generateApiKey, hashApiKey } from '../src/keys.js'

describe('api keys', () => {
  test('generates mm_live_ prefixed plaintext', () => {
    const k = generateApiKey()
    expect(k.plaintext.startsWith('mm_live_')).toBe(true)
    expect(k.plaintext.length).toBeGreaterThan(20)
  })

  test('prefix is first 12 chars of plaintext', () => {
    const k = generateApiKey()
    expect(k.prefix).toBe(k.plaintext.slice(0, 12))
    expect(k.prefix.startsWith('mm_live_')).toBe(true)
  })

  test('hash is 64-char hex and matches hashApiKey', () => {
    const k = generateApiKey()
    expect(k.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hashApiKey(k.plaintext)).toBe(k.hash)
  })

  test('two generated keys differ', () => {
    expect(generateApiKey().plaintext).not.toBe(generateApiKey().plaintext)
  })
})
