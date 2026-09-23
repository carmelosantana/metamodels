import { describe, expect, test } from 'vitest'
import { flockConnectionInput, saveFlockInput } from './flock-schema'

// `upstreamAuth` is a bare token: every call to the flock sends `Authorization: Bearer <token>`.
// A scheme, a space or a control character would build a wrong header, or inject one.
const BASE = { breed: 'ollama', name: 'f', baseUrl: 'http://o:11434', tlsTrust: false }

describe.each([
  ['saveFlockInput', saveFlockInput],
  ['flockConnectionInput', flockConnectionInput],
] as const)('%s upstreamAuth', (_name, schema) => {
  test.each(['t0ken', 'sk-abc.DEF_123~+/=', 'eyJhbGciOi.eyJzdWIi.c2ln'])('accepts the bare token %j', (token) => {
    expect(schema.parse({ ...BASE, upstreamAuth: token }).upstreamAuth).toBe(token)
  })

  test('trims surrounding whitespace, as before', () => {
    expect(schema.parse({ ...BASE, upstreamAuth: '  t0ken \n' }).upstreamAuth).toBe('t0ken')
  })

  test.each([
    ['a Bearer scheme', 'Bearer t0ken'],
    ['a lower-case scheme', 'bearer t0ken'],
    ['a Basic scheme', 'Basic dXNlcjpwYXNz'],
    ['inner whitespace', 't0 ken'],
    ['a tab', 't0\tken'],
    ['CR/LF header injection', 't0ken\r\nX-Injected: 1'],
    ['a NUL', 't0\u0000ken'],
    ['a DEL', 't0\u007fken'],
  ])('rejects %s, telling the operator to paste the token only', (_why, value) => {
    const r = schema.safeParse({ ...BASE, upstreamAuth: value })
    expect(r.success).toBe(false)
    expect(r.error?.issues.map((i) => i.message).join()).toMatch(/token only/i)
  })

  test('null and omitted stay valid', () => {
    expect(schema.safeParse({ ...BASE, upstreamAuth: null }).success).toBe(true)
    expect(schema.safeParse(BASE).success).toBe(true)
  })
})
