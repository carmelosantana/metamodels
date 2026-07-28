import { describe, expect, test } from 'vitest'
import { parseGraphText, graphTargets } from './template-builder'
import { buildTemplate, dryRunTemplate, validateDraft } from './template-builder'
import { reconstructGraph } from '@metamodels/connectors'

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

const FULL_GRAPH = {
  '3': { class_type: 'KSampler', inputs: { seed: 0, steps: 20 } },
  '4': { class_type: 'CLIPTextEncode', inputs: { text: '' } },
  '10': { class_type: 'LoadImage', inputs: { image: '' } },
}
const goodDraft = {
  id: 'txt2img',
  graphText: JSON.stringify(FULL_GRAPH),
  params: [
    { name: 'prompt', type: 'text', target: { node: '4', input: 'text' } },
    { name: 'seed', type: 'seed', targets: [{ node: '3', input: 'seed' }] },
    { name: 'steps', type: 'number', target: { node: '3', input: 'steps' }, min: 1, max: 50 },
    { name: 'source', type: 'image', target: { node: '10', input: 'image' } },
  ],
  cost: 2,
}

describe('buildTemplate', () => {
  test('assembles a WorkflowTemplate that validates against comfyuiConstraint', () => {
    const r = buildTemplate({ ...goodDraft, graphText: goodDraft.graphText } as never)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.id).toBe('txt2img')
      expect(r.value.params).toHaveLength(4)
      expect(r.value.cost).toBe(2)
    }
  })
  test('rejects a draft whose graph text is unparseable', () => {
    const r = buildTemplate({ ...goodDraft, graphText: '{ bad' } as never)
    expect(r.ok).toBe(false)
  })
  test('rejects duplicate param names', () => {
    const r = buildTemplate({
      ...goodDraft,
      params: [
        { name: 'p', type: 'text', target: { node: '4', input: 'text' } },
        { name: 'p', type: 'number', target: { node: '3', input: 'steps' } },
      ],
    } as never)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason.toLowerCase()).toContain('duplicate')
  })
})

describe('dryRunTemplate', () => {
  test('reconstructs a good template (all targets resolve)', () => {
    const b = buildTemplate(goodDraft as never)
    expect(b.ok).toBe(true)
    if (!b.ok) return
    const r = dryRunTemplate(b.value)
    expect(r.ok).toBe(true)
  })
  test('fails when a param targets a node that is not in the graph', () => {
    const b = buildTemplate({
      ...goodDraft,
      params: [{ name: 'prompt', type: 'text', target: { node: '999', input: 'text' } }],
    } as never)
    expect(b.ok).toBe(true) // shape is fine
    if (!b.ok) return
    const r = dryRunTemplate(b.value)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('999')
  })
})

describe('validateDraft — security invariants hold end-to-end', () => {
  test('a validated template rejects an UNDECLARED consumer param at reconstruct time', () => {
    const v = validateDraft(goodDraft)
    expect(v.ok).toBe(true)
    if (!v.ok) return
    const out = reconstructGraph(v.value, { prompt: 'hi', evil: 'x' }, {})
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('unknown param')
  })
  test('SEED is server-generated: reconstruct fills the seed target even with no seed in consumer params', () => {
    const v = validateDraft(goodDraft)
    if (!v.ok) throw new Error('draft should be valid')
    const out = reconstructGraph(v.value, { prompt: 'hi' }, { uploads: { source: 'up.png' }, rng: () => 0.5 })
    expect(out.ok).toBe(true)
    if (out.ok) {
      // rng: () => 0.5 => Math.floor(0.5 * 1e12) = 500000000000. Asserting the exact
      // rng-derived value proves the seed came from server-side generation, not the
      // fixture's pre-existing `0`. A `typeof === 'number'` check would pass trivially
      // (and even if seed auto-generation were deleted) because the fixture stores `0`.
      expect(out.graph['3'].inputs.seed).toBe(500000000000)
      expect(out.graph['3'].inputs.seed).not.toBe(0)
    }
  })
  test('IMAGE resolves from the upload slot, not the consumer value', () => {
    const v = validateDraft(goodDraft)
    if (!v.ok) throw new Error('draft should be valid')
    const out = reconstructGraph(v.value, { prompt: 'hi', source: 'IGNORED' }, { uploads: { source: 'trusted.png' } })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.graph['10'].inputs.image).toBe('trusted.png')
  })
  test('rejects the whole draft when a target does not resolve (dry-run gate)', () => {
    const bad = { ...goodDraft, params: [{ name: 'p', type: 'text', target: { node: 'NOPE', input: 'text' } }] }
    const v = validateDraft(bad)
    expect(v.ok).toBe(false)
  })
})
