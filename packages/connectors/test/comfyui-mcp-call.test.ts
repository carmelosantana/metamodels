import { describe, expect, test } from 'vitest'
import { comfyMcpCall, comfyMcpResult, comfyToMcp, comfyuiBreed, comfyuiConstraint, JOB_RESULT_TOOL } from '../src/index.js'

const template = (id: string) => ({
  id,
  graph: { '6': { class_type: 'CLIPTextEncode', inputs: { text: 'x' } } },
  params: [{ name: 'prompt', type: 'text', target: { node: '6', input: 'text' } }],
  cost: 1,
})
const fence = comfyuiConstraint.parse({ templates: [template('txt2img'), template('a b'), template('a_b')] })

describe('comfyMcpCall (M4 D8)', () => {
  test('run_<tpl> plans the template submit the proxy receives, inverting the name through comfyToolNames', () => {
    expect(comfyMcpCall('run_txt2img', { prompt: 'a cat' }, fence)).toEqual({
      ok: true, request: { method: 'POST', path: '/submit', body: { template_id: 'txt2img', params: { prompt: 'a cat' } } },
    })
    // Sanitising collided: `a b` → run_a_b, `a_b` → run_a_b_2. The map, not un-sanitising, decides.
    expect(comfyMcpCall('run_a_b', {}, fence)).toMatchObject({ ok: true, request: { body: { template_id: 'a b' } } })
    expect(comfyMcpCall('run_a_b_2', {}, fence)).toMatchObject({ ok: true, request: { body: { template_id: 'a_b' } } })
  })

  test('get_job_result plans the scoped result route, with the id path-encoded', () => {
    expect(comfyMcpCall(JOB_RESULT_TOOL, { job_id: 'cf-1' }, fence)).toEqual({ ok: true, request: { method: 'GET', path: '/result/cf-1' } })
    expect(comfyMcpCall(JOB_RESULT_TOOL, { job_id: '../prompt' }, fence)).toEqual({ ok: true, request: { method: 'GET', path: '/result/..%2Fprompt' } })
  })

  test('bad arguments and unlisted tools are refused', () => {
    expect(comfyMcpCall(JOB_RESULT_TOOL, {}, fence)).toEqual({ ok: false, error: 'invalid arguments: job_id must be a non-empty string' })
    expect(comfyMcpCall('run_txt2img', ['x'], fence)).toEqual({ ok: false, error: 'invalid arguments: expected an object' })
    expect(comfyMcpCall('run_ghost', {}, fence)).toEqual({ ok: false, error: 'unknown tool: run_ghost' })
    expect(comfyMcpCall(JOB_RESULT_TOOL, { job_id: 'x' }, comfyuiConstraint.parse({ templates: [] }))).toEqual({ ok: false, error: `unknown tool: ${JOB_RESULT_TOOL}` })
  })

  test('no tool plans one of the breed\'s own upstream routes (all are refused by guard, and /upload/image is mutate)', () => {
    const own = comfyuiBreed.routes.map((r) => r.path)
    for (const tool of comfyToMcp(fence)) {
      const plan = comfyMcpCall(tool.name, tool.name === JOB_RESULT_TOOL ? { job_id: 'j' } : {}, fence)
      expect(plan.ok, tool.name).toBe(true)
      if (!plan.ok) continue
      expect(own.some((p) => plan.request.path === p || plan.request.path.startsWith(`${p}/`)), tool.name).toBe(false)
      const route = comfyuiBreed.routes.find((r) => r.path === plan.request.path && r.method === plan.request.method)
      expect(route?.class, tool.name).not.toBe('mutate')
    }
  })
})

describe('comfyMcpResult', () => {
  test('a run returns its job_id as text and structuredContent', () => {
    expect(comfyMcpResult('run_txt2img', { status: 202, body: { job_id: 'cf-1' } }, fence)).toEqual({
      content: [{ type: 'text', text: `Job cf-1 started. Call ${JOB_RESULT_TOOL} with this job_id for the output.` }],
      structuredContent: { job_id: 'cf-1' },
    })
  })

  test('a finished job returns each attached image as image content, and the references as structuredContent', () => {
    const r = comfyMcpResult(JOB_RESULT_TOOL, {
      status: 200,
      body: { done: true, images: [{ filename: 'o.png', subfolder: '', type: 'output', data: 'AAAA', mimeType: 'image/png' }] },
    }, fence)
    expect(r).toEqual({
      content: [{ type: 'text', text: 'Job finished with 1 image.' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }],
      structuredContent: { done: true, images: [{ filename: 'o.png', subfolder: '', type: 'output' }] },
    })
  })

  test('a pending job says so; a refusal from handle is isError with its reason', () => {
    expect(comfyMcpResult(JOB_RESULT_TOOL, { status: 200, body: { done: false, images: [] } }, fence).content)
      .toEqual([{ type: 'text', text: 'Job still running. Call again later.' }])
    expect(comfyMcpResult(JOB_RESULT_TOOL, { status: 404, body: { error: 'not found' } }, fence))
      .toEqual({ content: [{ type: 'text', text: 'not found' }], isError: true })
    expect(comfyMcpResult('run_txt2img', { status: 422, body: { error: "undeclared param 'x'" } }, fence))
      .toEqual({ content: [{ type: 'text', text: "undeclared param 'x'" }], isError: true })
  })
})
