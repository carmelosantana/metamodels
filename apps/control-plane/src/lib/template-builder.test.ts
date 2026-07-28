import { describe, expect, test } from 'vitest'
import { parseGraphText, graphTargets } from './template-builder'

const GRAPH = {
  '4': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 0] } },
  '3': { class_type: 'KSampler', inputs: { seed: 0, steps: 20 } },
}

describe('parseGraphText', () => {
  test('parses valid workflow-api json', () => {
    const r = parseGraphText(JSON.stringify(GRAPH))
    expect(r.ok).toBe(true)
    if (r.ok) expect(Object.keys(r.value)).toContain('4')
  })
  test('fails on non-json with a friendly reason', () => {
    const r = parseGraphText('{ not json')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason.toLowerCase()).toContain('json')
  })
  test('fails on json that is not a valid graph', () => {
    const r = parseGraphText(JSON.stringify({ '3': { inputs: {} } }))
    expect(r.ok).toBe(false)
  })
})

describe('graphTargets', () => {
  test('lists nodes (sorted) with their input keys (sorted)', () => {
    expect(graphTargets(GRAPH)).toEqual([
      { node: '3', inputs: ['seed', 'steps'] },
      { node: '4', inputs: ['clip', 'text'] },
    ])
  })
})
