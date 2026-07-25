import { describe, expect, test } from 'vitest'
import { BreedRegistry } from '../src/registry.js'
import { echoBreed } from '../src/testing/echo-breed.js'

describe('BreedRegistry', () => {
  test('registers and gets a breed', () => {
    const r = new BreedRegistry()
    r.register(echoBreed)
    expect(r.has('echo')).toBe(true)
    expect(r.get('echo').displayName).toBe('Echo (test)')
    expect(r.ids()).toEqual(['echo'])
  })

  test('throws on duplicate registration', () => {
    const r = new BreedRegistry()
    r.register(echoBreed)
    expect(() => r.register(echoBreed)).toThrow(/already registered/)
  })

  test('throws on unknown breed', () => {
    const r = new BreedRegistry()
    expect(() => r.get('nope')).toThrow(/Unknown breed/)
  })
})
