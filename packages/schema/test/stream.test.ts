import { describe, expect, test } from 'vitest'
import { decodeMeterEvent, encodeMeterEvent, type MeterStreamEvent } from '../src/stream.js'

const ev: MeterStreamEvent = {
  orgId: 'o', keyId: 'k', paddockId: 'p', breedId: 'ollama', dim: 'tokens_out', value: 42, at: 1000,
}

describe('meter stream codec', () => {
  test('encode → XADD field map with a single json `data` field', () => {
    const fields = encodeMeterEvent(ev)
    expect(fields).toEqual({ data: JSON.stringify(ev) })
  })
  test('decode reverses encode from a flat [field, value, ...] array', () => {
    const { data } = encodeMeterEvent(ev)
    expect(decodeMeterEvent(['data', data])).toEqual(ev)
  })
})
