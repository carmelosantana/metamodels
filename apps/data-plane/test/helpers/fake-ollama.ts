import { Hono } from 'hono'

function ndjson(lines: unknown[]): Response {
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
}

export function createFakeOllama(): Hono {
  const app = new Hono()

  app.get('/api/version', (c) => c.json({ version: 'test' }))
  app.get('/api/tags', (c) =>
    c.json({ models: [{ name: 'llama3.2:1b', model: 'llama3.2:1b', size: 1234, details: { parameter_size: '1.2B' } }] }),
  )

  app.post('/api/chat', async (c) => {
    const body = await c.req.json<{ stream?: boolean }>()
    const finalFrame = { model: 'llama3.2:1b', done: true, done_reason: 'stop', prompt_eval_count: 11, eval_count: 22 }
    if (body.stream === false) return c.json(finalFrame)
    return ndjson([
      { message: { role: 'assistant', content: 'Hel' }, done: false },
      { message: { role: 'assistant', content: 'lo' }, done: false },
      finalFrame,
    ])
  })

  app.post('/api/generate', async (c) => {
    const body = await c.req.json<{ stream?: boolean }>()
    const finalFrame = { done: true, response: '', prompt_eval_count: 9, eval_count: 13 }
    if (body.stream === false) return c.json({ response: 'hi', ...finalFrame })
    return ndjson([{ response: 'hi', done: false }, finalFrame])
  })

  app.post('/api/embed', (c) => c.json({ embeddings: [[0.1, 0.2]], prompt_eval_count: 5 }))

  app.post('/v1/chat/completions', (c) =>
    c.json({
      id: 'x', object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
    }),
  )

  // Should never be reached — guard denies model-management before proxying.
  app.post('/api/pull', (c) => c.json({ status: 'success' }))

  return app
}
