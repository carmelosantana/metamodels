import { describe, expect, test } from 'vitest'
import { reconstructGraph } from '../src/comfyui/template.js'
import type { WorkflowTemplate } from '../src/comfyui/template.js'

// A small inline graph mirroring a latex.pics v0.3.2 shape:
// - a CLIPTextEncode node for the prompt (text param)
// - a KSampler with a seed input (seed param) and a steps input (number param)
// - a LoadImage node for the image case (image param)
function makeTemplate(): WorkflowTemplate {
  return {
    id: 'latex-pics-v0.3.2',
    cost: 1,
    graph: {
      '3': {
        class_type: 'KSampler',
        inputs: { seed: 0, steps: 20, cfg: 7, denoise: 1 },
      },
      '6': {
        class_type: 'CLIPTextEncode',
        inputs: { text: 'default prompt' },
      },
      '10': {
        class_type: 'LoadImage',
        inputs: { image: 'placeholder.png' },
      },
    },
    params: [
      { name: 'prompt', type: 'text', target: { node: '6', input: 'text' } },
      { name: 'seed', type: 'seed', targets: [{ node: '3', input: 'seed' }] },
      { name: 'steps', type: 'number', target: { node: '3', input: 'steps' }, min: 1, max: 50 },
      { name: 'photo', type: 'image', target: { node: '10', input: 'image' } },
    ],
  }
}

describe('reconstructGraph', () => {
  test('declared text param lands in the right node input', () => {
    const tpl = makeTemplate()
    const res = reconstructGraph(tpl, { prompt: 'a cat' }, { rng: () => 0 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.graph['6'].inputs.text).toBe('a cat')
  })

  test('rejects a non-string value for a text param', () => {
    const tpl = makeTemplate()
    const res = reconstructGraph(tpl, { prompt: 123 }, {})
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/prompt/)
  })

  test('rejects an undeclared param (core security property)', () => {
    const tpl = makeTemplate()
    const res = reconstructGraph(tpl, { evil: 'inject', prompt: 'a cat' }, {})
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('unknown param: evil')
  })

  test('seed is randomized into the KSampler via injected rng (deterministic)', () => {
    const tpl = makeTemplate()
    const res = reconstructGraph(tpl, {}, { rng: () => 0.5 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.graph['3'].inputs.seed).toBe(Math.floor(0.5 * 1e12))
  })

  test('seed is randomized on every reconstruct even when not supplied in params', () => {
    const tpl = makeTemplate()
    const res = reconstructGraph(tpl, {}, { rng: () => 0.123456 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.graph['3'].inputs.seed).toBe(Math.floor(0.123456 * 1e12))
    // and it differs from the stored default of 0
    expect(res.graph['3'].inputs.seed).not.toBe(0)
  })

  test('number within range is written to the target input', () => {
    const tpl = makeTemplate()
    const res = reconstructGraph(tpl, { steps: 30 }, { rng: () => 0 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.graph['3'].inputs.steps).toBe(30)
  })

  test('number out-of-range is rejected', () => {
    const tpl = makeTemplate()
    const res = reconstructGraph(tpl, { steps: 999 }, {})
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/steps/)
  })

  test('non-number value for a number param is rejected', () => {
    const tpl = makeTemplate()
    const res = reconstructGraph(tpl, { steps: 'lots' }, {})
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/steps/)
  })

  test('an unbounded number param rejects Infinity (must be finite)', () => {
    const tpl = makeTemplate()
    // Drop the min/max so only the finiteness check can reject it.
    const stepsSpec = tpl.params.find((p) => p.name === 'steps')
    if (stepsSpec && stepsSpec.type === 'number') {
      delete stepsSpec.min
      delete stepsSpec.max
    }
    for (const bad of [Infinity, -Infinity]) {
      const res = reconstructGraph(tpl, { steps: bad }, {})
      expect(res.ok).toBe(false)
      if (res.ok) return
      expect(res.reason).toMatch(/steps/)
    }
  })

  test('image param is rejected when the upload filename is absent', () => {
    const tpl = makeTemplate()
    const res = reconstructGraph(tpl, { photo: 'ignored' }, {})
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/photo/)
  })

  test('image param injects the uploaded filename into LoadImage', () => {
    const tpl = makeTemplate()
    const res = reconstructGraph(
      tpl,
      { photo: 'ignored' },
      { uploads: { photo: 'uploaded-abc123.png' }, rng: () => 0 },
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.graph['10'].inputs.image).toBe('uploaded-abc123.png')
  })

  test('the stored template object is not mutated after reconstruct', () => {
    const tpl = makeTemplate()
    const before = structuredClone(tpl)
    reconstructGraph(
      tpl,
      { prompt: 'a cat', steps: 30 },
      { uploads: { photo: 'uploaded-abc123.png' }, rng: () => 0.5 },
    )
    expect(tpl).toEqual(before)
  })

  test('a spec targeting a missing node is rejected defensively', () => {
    const tpl = makeTemplate()
    tpl.params.push({ name: 'ghost', type: 'text', target: { node: '999', input: 'text' } })
    const res = reconstructGraph(tpl, { ghost: 'boo' }, {})
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/999|ghost/)
  })
})
