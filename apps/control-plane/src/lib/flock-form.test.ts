import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { flockFormToInput } from './flock-form'

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

// `lib/` is where client components look for helpers. One that imports server code (the database,
// node:crypto, the keyring) would drag it into the browser bundle the day a client component uses it.
test('lib/flock-form.ts imports nothing from server/', () => {
  const src = readFileSync(new URL('./flock-form.ts', import.meta.url), 'utf8')
  expect(src).not.toMatch(/from ['"][^'"]*server\//)
  expect(src).not.toMatch(/node:/)
})
