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

import {
  CONFIG_INVALIDATE_CHANNEL, encodeConfigInvalidation, decodeConfigInvalidation,
} from '../src/stream.js'

describe('config invalidation codec', () => {
  test('channel name is stable', () => {
    expect(CONFIG_INVALIDATE_CHANNEL).toBe('metamodels:config:invalidate')
  })

  test('encode → decode round-trips reason + at', () => {
    const payload = encodeConfigInvalidation('flock.save', 1_700_000_000_000)
    expect(decodeConfigInvalidation(payload)).toEqual({ reason: 'flock.save', at: 1_700_000_000_000 })
  })

  test('decode rejects malformed payloads', () => {
    expect(() => decodeConfigInvalidation('not json')).toThrow()
    expect(() => decodeConfigInvalidation(JSON.stringify({ reason: 'x' }))).toThrow() // missing at
    expect(() => decodeConfigInvalidation(JSON.stringify({ at: 1 }))).toThrow() // missing reason
  })
})
