import { describe, expect, test } from 'vitest'
import { ollamaBreed, ollamaConstraint, ollamaMcpCall, ollamaMcpResult, ollamaModelAllowed, ollamaToMcp, routeGroup } from '../src/index.js'

const fence = ollamaConstraint.parse({ allowedRoutes: ['chat', 'generate', 'embed', 'read'], allowedModels: ['llama3.2:1b'] })
const open = ollamaConstraint.parse({ allowedRoutes: ['chat', 'generate', 'embed', 'read'], allowedModels: null })
const messages = [{ role: 'user', content: 'hi' }]

describe('ollamaMcpCall (M4 D8)', () => {
  test('chat, generate and embed plan the proxy route with stream: false; list_models plans GET /api/tags', () => {
    expect(ollamaMcpCall('chat', { model: 'llama3.2:1b', messages }, fence)).toEqual({
      ok: true, request: { method: 'POST', path: '/api/chat', body: { model: 'llama3.2:1b', messages, stream: false } },
    })
    expect(ollamaMcpCall('generate', { model: 'llama3.2:1b', prompt: 'p', system: 's' }, fence)).toEqual({
      ok: true, request: { method: 'POST', path: '/api/generate', body: { model: 'llama3.2:1b', prompt: 'p', system: 's', stream: false } },
    })
    expect(ollamaMcpCall('embed', { model: 'llama3.2:1b', input: ['a'] }, fence)).toEqual({
      ok: true, request: { method: 'POST', path: '/api/embed', body: { model: 'llama3.2:1b', input: ['a'] } },
    })
    expect(ollamaMcpCall('list_models', {}, fence)).toEqual({ ok: true, request: { method: 'GET', path: '/api/tags' } })
  })

  test('a caller cannot turn streaming back on, or smuggle fields the schema does not declare', () => {
    const plan = ollamaMcpCall('chat', { model: 'llama3.2:1b', messages, stream: true, keep_alive: -1, options: { num_gpu: 99 } }, fence)
    expect(plan).toEqual({ ok: true, request: { method: 'POST', path: '/api/chat', body: { model: 'llama3.2:1b', messages, stream: false } } })
  })

  test('chat rebuilds each message from role and content alone', () => {
    const sent = [{ role: 'system', content: 's' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'u' }]
    const plan = ollamaMcpCall('chat', { model: 'llama3.2:1b', messages: sent }, fence)
    expect(plan).toEqual({ ok: true, request: { method: 'POST', path: '/api/chat', body: { model: 'llama3.2:1b', messages: sent, stream: false } } })
    if (!plan.ok) return
    const planned = (plan.request.body as { messages: unknown[] }).messages
    for (const [i, m] of planned.entries()) expect(m, String(i)).not.toBe(sent[i])
  })

  test('a chat message that is not exactly { role, content } is refused, never forwarded', () => {
    const cases: Array<[unknown[], string]> = [
      [[{ role: 'user', content: 'hi', images: ['aGk='] }], 'messages[0] may carry only role and content'],
      [[{ role: 'user', content: 'hi' }, { role: 'assistant', content: '', tool_calls: [] }], 'messages[1] may carry only role and content'],
      [[{ role: 'tool', content: 'x' }], 'messages[0].role must be system, user or assistant'],
      [[{ content: 'x' }], 'messages[0].role must be system, user or assistant'],
      [[{ role: 'user', content: 42 }], 'messages[0].content must be a string'],
      [[{ role: 'user' }], 'messages[0].content must be a string'],
      [['hi'], 'messages[0] must be an object'],
      [[null], 'messages[0] must be an object'],
      [[['user', 'hi']], 'messages[0] must be an object'],
    ]
    for (const [messages, why] of cases) {
      expect(ollamaMcpCall('chat', { model: 'm', messages }, open), why).toEqual({ ok: false, error: `invalid arguments: ${why}` })
    }
  })

  test('embed input must be strings', () => {
    for (const input of [[1], ['a', null], [{ text: 'a' }], [['a']]]) {
      expect(ollamaMcpCall('embed', { model: 'm', input }, open), JSON.stringify(input))
        .toEqual({ ok: false, error: 'invalid arguments: input must be an array of strings' })
    }
  })

  test('the model is NOT checked here: guard() is the enforcement point', () => {
    const plan = ollamaMcpCall('chat', { model: 'llama3:70b', messages }, fence)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const guard = ollamaBreed.guard({ ...plan.request, headers: {}, paddockSlug: 's' }, fence)
    expect(guard).toMatchObject({ ok: false, status: 403, reason: 'model not allowed: llama3:70b' })
  })

  test('malformed arguments and tools this fence does not list are refused', () => {
    expect(ollamaMcpCall('chat', { model: 'llama3.2:1b' }, fence)).toEqual({ ok: false, error: 'invalid arguments: messages must be a non-empty array' })
    expect(ollamaMcpCall('generate', { model: 1, prompt: 'p' }, fence)).toEqual({ ok: false, error: 'invalid arguments: model must be a string' })
    expect(ollamaMcpCall('chat', 'not an object', fence)).toEqual({ ok: false, error: 'invalid arguments: expected an object' })
    const chatOnly = ollamaConstraint.parse({ allowedRoutes: ['chat'], allowedModels: null })
    expect(ollamaMcpCall('embed', { model: 'm', input: ['a'] }, chatOnly)).toEqual({ ok: false, error: 'unknown tool: embed' })
    expect(ollamaMcpCall('pull', { name: 'x' }, fence)).toEqual({ ok: false, error: 'unknown tool: pull' })
  })

  test('no tool of any fence plans a mutate or unknown route (parent §5)', () => {
    const fences = [fence, open, ollamaConstraint.parse({ allowedRoutes: ['read'], allowedModels: [] })]
    const args: Record<string, unknown> = {
      chat: { model: 'm', messages }, generate: { model: 'm', prompt: 'p' }, embed: { model: 'm', input: ['a'] }, list_models: {},
    }
    for (const f of fences) {
      for (const tool of ollamaToMcp(f)) {
        const plan = ollamaMcpCall(tool.name, args[tool.name], f)
        expect(plan.ok, tool.name).toBe(true)
        if (!plan.ok) continue
        const group = routeGroup(plan.request.path)
        expect(['mutate', 'unknown']).not.toContain(group)
        const route = ollamaBreed.routes.find((r) => r.path === plan.request.path && r.method === plan.request.method)
        expect(route?.class, tool.name).not.toBe('mutate')
      }
    }
  })
})

describe('ollamaMcpResult', () => {
  test('chat returns the assistant text, plus the upstream frame as structuredContent', () => {
    const body = { model: 'llama3.2:1b', message: { role: 'assistant', content: 'Hello' }, done: true, eval_count: 2 }
    expect(ollamaMcpResult('chat', { status: 200, body }, fence)).toEqual({ content: [{ type: 'text', text: 'Hello' }], structuredContent: body })
  })

  test('generate returns the response text; embed the embedding array; list_models the names', () => {
    expect(ollamaMcpResult('generate', { status: 200, body: { response: 'hi', done: true } }, fence).content).toEqual([{ type: 'text', text: 'hi' }])
    const embed = ollamaMcpResult('embed', { status: 200, body: { embeddings: [[0.1, 0.2]] } }, fence)
    expect(embed).toEqual({ content: [{ type: 'text', text: '[[0.1,0.2]]' }], structuredContent: { embeddings: [[0.1, 0.2]] } })
    const models = ollamaMcpResult('list_models', { status: 200, body: { models: [{ name: 'b' }, { name: 'a' }, { nope: 1 }] } }, open)
    expect(models).toEqual({ content: [{ type: 'text', text: 'a\nb' }], structuredContent: { models: ['a', 'b'] } })
  })

  test('list_models keeps only the models the fence allows (ruling S2); null allows every model', () => {
    const upstream = { status: 200, body: { models: [{ name: 'a' }, { name: 'b' }] } }
    const onlyA = ollamaConstraint.parse({ allowedRoutes: ['read'], allowedModels: ['a'] })
    expect(ollamaMcpResult('list_models', upstream, onlyA)).toEqual({ content: [{ type: 'text', text: 'a' }], structuredContent: { models: ['a'] } })
    const all = ollamaConstraint.parse({ allowedRoutes: ['read'], allowedModels: null })
    expect(ollamaMcpResult('list_models', upstream, all)).toEqual({ content: [{ type: 'text', text: 'a\nb' }], structuredContent: { models: ['a', 'b'] } })
  })

  test('list_models filters with the same matcher guard() enforces', () => {
    const names = ['llama3.2:1b', 'llama3.2', 'llama3:70b']
    const body = { models: names.map((name) => ({ name })) }
    const kept = (ollamaMcpResult('list_models', { status: 200, body }, fence).structuredContent as { models: string[] }).models
    for (const name of names) {
      const guard = ollamaBreed.guard({ method: 'POST', path: '/api/chat', headers: {}, body: { model: name }, paddockSlug: 's' }, fence)
      expect(kept.includes(name), name).toBe(guard.ok)
      expect(ollamaModelAllowed(fence, name), name).toBe(guard.ok)
    }
  })

  test('an upstream error or an unreadable body is isError, never a thrown error', () => {
    expect(ollamaMcpResult('chat', { status: 404, body: { error: 'model "x" not found' } }, fence))
      .toEqual({ content: [{ type: 'text', text: 'upstream error (404): model "x" not found' }], isError: true })
    expect(ollamaMcpResult('chat', { status: 200, body: undefined }, fence))
      .toEqual({ content: [{ type: 'text', text: 'the upstream answer could not be read' }], isError: true })
  })
})
