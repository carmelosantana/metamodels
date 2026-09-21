import { describe, expect, test } from 'vitest'
import {
  comfyToMcp, comfyToolName, comfyToolNames, comfyuiBreed, comfyuiConstraint, toolDefProblems,
  type WorkflowTemplate,
} from '../src/index.js'

function tpl(id: string, params: WorkflowTemplate['params'] = [], cost = 1): WorkflowTemplate {
  return { id, graph: { '1': { class_type: 'KSampler', inputs: {} } }, params, cost }
}

const txt2img = tpl('txt2img', [
  { name: 'prompt', type: 'text', target: { node: '1', input: 'text' } },
  { name: 'steps', type: 'number', target: { node: '1', input: 'steps' }, min: 1, max: 50 },
  { name: 'seed', type: 'seed', targets: [{ node: '1', input: 'seed' }] },
  { name: 'init', type: 'image', target: { node: '1', input: 'image' } },
], 2)

describe('comfyToolName', () => {
  test('prefixes and sanitises the template id', () => {
    expect(comfyToolName('txt2img')).toBe('run_txt2img')
    expect(comfyToolName('sdxl turbo/v2')).toBe('run_sdxl_turbo_v2')
    expect(comfyToolName('')).toBe('run__')
  })

  test('caps the name at 128 characters', () => {
    expect(comfyToolName('x'.repeat(300))).toHaveLength(128)
  })
})

describe('comfyToolNames', () => {
  test('suffixes collisions in template order and maps each name back to its id', () => {
    expect([...comfyToolNames([tpl('a b'), tpl('a_b'), tpl('a/b')])]).toEqual([
      ['run_a_b', 'a b'], ['run_a_b_2', 'a_b'], ['run_a_b_3', 'a/b'],
    ])
  })

  test('a duplicate template id gets no second tool (submit resolves the first)', () => {
    expect([...comfyToolNames([tpl('dup'), tpl('dup')])]).toEqual([['run_dup', 'dup']])
  })

  test('suffixed names still fit in 128 characters', () => {
    const long = 'y'.repeat(200)
    const got = [...comfyToolNames([tpl(long), tpl(`${long}!`)]).keys()]
    expect(got.map((n) => n.length)).toEqual([128, 128])
    expect(got[1].endsWith('_2')).toBe(true)
  })
})

describe('comfyToMcp', () => {
  test('no templates, no tools', () => {
    expect(comfyToMcp(comfyuiConstraint.parse({}))).toEqual([])
  })

  test('one run tool per template plus get_job_result, sorted and valid', () => {
    const tools = comfyToMcp({ templates: [tpl('upscale'), txt2img] })
    expect(tools.map((t) => t.name)).toEqual(['get_job_result', 'run_txt2img', 'run_upscale'])
    expect(toolDefProblems(tools)).toEqual([])
    const upscale = tools.find((t) => t.name === 'run_upscale')!
    expect(upscale.description).toContain('1 job unit.')
    expect(upscale.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false })
  })

  test('params map to JSON Schema, and seeds are never caller inputs', () => {
    const run = comfyToMcp({ templates: [txt2img] }).find((t) => t.name === 'run_txt2img')!
    expect(run.inputSchema).toEqual({
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        steps: { type: 'number', minimum: 1, maximum: 50 },
        init: { type: 'string', contentEncoding: 'base64', description: 'Base64-encoded image bytes.' },
      },
      additionalProperties: false,
    })
    expect(run.description).toContain('2 job units.')
  })

  test('get_job_result takes exactly a job_id', () => {
    const get = comfyToMcp({ templates: [txt2img] }).find((t) => t.name === 'get_job_result')!
    expect(get.inputSchema).toEqual({
      type: 'object', properties: { job_id: { type: 'string', minLength: 1 } }, required: ['job_id'], additionalProperties: false,
    })
    expect(get.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true })
  })

  test('a param named __proto__ becomes an own property, not a prototype', () => {
    const odd = tpl('odd', [{ name: '__proto__', type: 'text', target: { node: '1', input: 'text' } }])
    const props = comfyToMcp({ templates: [odd] }).find((t) => t.name === 'run_odd')!.inputSchema.properties!
    expect(Object.getOwnPropertyDescriptor(props, '__proto__')?.value).toEqual({ type: 'string' })
    expect(Object.getPrototypeOf(props)).toBe(Object.prototype)
  })

  test('pure, and wired into the breed', () => {
    const fence = { templates: [txt2img] }
    const before = structuredClone(fence)
    expect(comfyToMcp(fence)).toEqual(comfyToMcp(fence))
    expect(fence).toEqual(before)
    expect(comfyuiBreed.toMcp).toBe(comfyToMcp)
  })
})
