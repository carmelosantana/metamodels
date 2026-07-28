import { describe, expect, test } from 'vitest'
import { graphSchema, templateDraftSchema } from './template-schema'

describe('graphSchema', () => {
  test('accepts a well-formed workflow-api graph', () => {
    const g = { '3': { class_type: 'KSampler', inputs: { seed: 0, steps: 20 } } }
    expect(graphSchema.parse(g)).toEqual(g)
  })
  test('rejects a node missing class_type', () => {
    expect(() => graphSchema.parse({ '3': { inputs: {} } })).toThrow()
  })
  test('rejects a node whose inputs is not an object', () => {
    expect(() => graphSchema.parse({ '3': { class_type: 'X', inputs: 5 } })).toThrow()
  })
})

describe('templateDraftSchema', () => {
  const graphText = JSON.stringify({ '4': { class_type: 'CLIPTextEncode', inputs: { text: '' } } })
  test('accepts a minimal draft with one text param', () => {
    const d = templateDraftSchema.parse({
      id: 'txt2img', graphText,
      params: [{ name: 'prompt', type: 'text', target: { node: '4', input: 'text' } }],
      cost: 1,
    })
    expect(d.id).toBe('txt2img')
    expect(d.params[0].type).toBe('text')
  })
  test('rejects an empty id', () => {
    expect(() => templateDraftSchema.parse({ id: '', graphText, params: [], cost: 1 })).toThrow()
  })
  test('rejects a negative cost', () => {
    expect(() => templateDraftSchema.parse({ id: 'x', graphText, params: [], cost: -1 })).toThrow()
  })
  test('rejects a param with an unknown type', () => {
    expect(() => templateDraftSchema.parse({
      id: 'x', graphText, params: [{ name: 'p', type: 'bogus', target: { node: '4', input: 'text' } }], cost: 1,
    })).toThrow()
  })
})
