import { describe, expect, test } from 'vitest'
import { CAPABILITIES } from '../src/capabilities.js'

// RFC 6749 §3.3: scope-token = 1*( %x21 / %x23-5B / %x5D-7E )
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/

describe('CAPABILITIES', () => {
  test('lists exactly the console capabilities, in a stable order', () => {
    expect(CAPABILITIES).toEqual(['read', 'resource.write', 'user.manage', 'license.manage'])
  })

  test('every capability is a valid, unique OAuth scope token', () => {
    for (const c of CAPABILITIES) expect(c).toMatch(SCOPE_TOKEN)
    expect(new Set(CAPABILITIES).size).toBe(CAPABILITIES.length)
  })
})
