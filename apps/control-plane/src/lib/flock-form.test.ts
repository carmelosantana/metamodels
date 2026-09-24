import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { flockFormToInput, movesCredential } from './flock-form'
import { saveFlockInput } from './flock-schema'

const form = (fields: Record<string, string>) => {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  return fd
}
const BASE = { breed: 'ollama', name: ' n ', baseUrl: ' http://o ', tlsTrust: 'true' }

describe('flockFormToInput', () => {
  test('trims the fields and reads the switch', () => {
    expect(flockFormToInput(form(BASE))).toMatchObject({ breed: 'ollama', name: 'n', baseUrl: 'http://o', tlsTrust: true })
  })

  test('a blank credential field is OMITTED — "leave it alone" — never null, which would clear it', () => {
    const input = flockFormToInput(form({ ...BASE, id: '00000000-0000-4000-8000-000000000000', upstreamAuth: '  ' }))
    expect(input).not.toHaveProperty('upstreamAuth')
    expect(flockFormToInput(form(BASE))).not.toHaveProperty('upstreamAuth')
  })

  test('a filled credential field is sent trimmed', () => {
    expect(flockFormToInput(form({ ...BASE, upstreamAuth: ' tok ' })).upstreamAuth).toBe('tok')
  })

  test('no id means create', () => {
    expect(flockFormToInput(form(BASE)).id).toBeUndefined()
  })
})

// The edit drawer's Keep / Replace / Remove choice for a stored credential.
describe('flockFormToInput: the credential choice', () => {
  const ID = '00000000-0000-4000-8000-000000000000'
  const EDIT = { ...BASE, id: ID }

  test('keep omits the credential, even if the (hidden) field still holds a token', () => {
    expect(flockFormToInput(form({ ...EDIT, credential: 'keep', upstreamAuth: 'tok' }))).not.toHaveProperty('upstreamAuth')
  })

  test('remove sends null, which clears it, whatever the field holds', () => {
    expect(flockFormToInput(form({ ...EDIT, credential: 'remove' })).upstreamAuth).toBeNull()
    expect(flockFormToInput(form({ ...EDIT, credential: 'remove', upstreamAuth: 'tok' })).upstreamAuth).toBeNull()
  })

  test('replace sends the trimmed token', () => {
    expect(flockFormToInput(form({ ...EDIT, credential: 'replace', upstreamAuth: ' tok ' })).upstreamAuth).toBe('tok')
  })

  test('replace with a blank field is sent blank, so validation refuses it rather than keeping the old one', () => {
    const input = flockFormToInput(form({ ...EDIT, credential: 'replace', upstreamAuth: '  ' }))
    expect(input.upstreamAuth).toBe('')
    expect(saveFlockInput.safeParse(input).success).toBe(false)
  })

  test('replace is validated as a bare token, and the refusal never echoes it', () => {
    for (const bad of ['Bearer s3cr3t', 's3c r3t', 's3cr3t\r\nx: y']) {
      const r = saveFlockInput.safeParse(flockFormToInput(form({ ...EDIT, credential: 'replace', upstreamAuth: bad })))
      expect(r.success).toBe(false)
      expect(JSON.stringify(r.error?.issues)).not.toContain('s3c')
    }
  })

  test('an unknown choice is refused rather than guessed at', () => {
    expect(() => flockFormToInput(form({ ...EDIT, credential: 'nope' }))).toThrow()
  })
})

// The rule behind the rebind 409, shared by `saveFlock` (which enforces it) and the edit drawer
// (which warns before the operator hits it).
describe('movesCredential', () => {
  const stored = { baseUrl: 'http://a', tlsTrust: false }
  test('a different base URL moves it', () => {
    expect(movesCredential(stored, { baseUrl: 'http://b', tlsTrust: false })).toBe(true)
  })
  test('turning TLS trust on moves it', () => {
    expect(movesCredential(stored, { baseUrl: 'http://a', tlsTrust: true })).toBe(true)
  })
  test('the same URL, or turning TLS trust off, does not', () => {
    expect(movesCredential(stored, { baseUrl: 'http://a', tlsTrust: false })).toBe(false)
    expect(movesCredential({ baseUrl: 'http://a', tlsTrust: true }, { baseUrl: 'http://a', tlsTrust: false })).toBe(false)
  })
})

// `lib/` is where client components look for helpers. One that imports server code (the database,
// node:crypto, the keyring) would drag it into the browser bundle the day a client component uses it.
test('lib/flock-form.ts imports nothing from server/', () => {
  const src = readFileSync(new URL('./flock-form.ts', import.meta.url), 'utf8')
  expect(src).not.toMatch(/from ['"][^'"]*server\//)
  expect(src).not.toMatch(/node:/)
})
