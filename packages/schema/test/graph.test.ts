import { describe, expect, test } from 'vitest'
import { parseGraphText, graphTargets } from '../src/graph.js'

const GOOD = JSON.stringify({
  '3': { class_type: 'KSampler', inputs: { seed: 0, steps: 20 } },
  '1': { class_type: 'CheckpointLoader', inputs: { ckpt_name: 'x.safetensors' } },
})

describe('graph parse helpers', () => {
  test('parses a valid workflow-API graph', () => {
    const r = parseGraphText(GOOD)
    expect(r.ok).toBe(true)
    if (r.ok) expect(Object.keys(r.value)).toHaveLength(2)
  })

  test('rejects invalid JSON with a friendly reason', () => {
    const r = parseGraphText('{ not json')
    expect(r).toEqual({ ok: false, reason: 'graph is not valid JSON' })
  })

  test('rejects a structurally-wrong graph', () => {
    const r = parseGraphText(JSON.stringify({ '3': { inputs: {} } })) // missing class_type
    expect(r.ok).toBe(false)
  })

  test('graphTargets enumerates node ids and input keys, both sorted', () => {
    const r = parseGraphText(GOOD)
    if (!r.ok) throw new Error('expected ok')
    expect(graphTargets(r.value)).toEqual([
      { node: '1', inputs: ['ckpt_name'] },
      { node: '3', inputs: ['seed', 'steps'] },
    ])
  })
})
