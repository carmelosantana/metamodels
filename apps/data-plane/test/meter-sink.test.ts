import { describe, expect, test } from 'vitest'
import { InMemoryMeterSink } from '../src/meter/meter-sink.js'
import { createFakeOllama } from './helpers/fake-ollama.js'

describe('InMemoryMeterSink', () => {
  test('accumulates emitted records', async () => {
    const sink = new InMemoryMeterSink()
    await sink.emit([{ orgId: 'o', keyId: 'k', paddockId: 'p', breedId: 'ollama', dim: 'tokens_in', value: 3, at: 1 }])
    await sink.emit([{ orgId: 'o', keyId: 'k', paddockId: 'p', breedId: 'ollama', dim: 'tokens_out', value: 4, at: 2 }])
    expect(sink.events).toHaveLength(2)
    expect(sink.events.map((e) => e.dim)).toEqual(['tokens_in', 'tokens_out'])
  })
})

describe('createFakeOllama', () => {
  test('streams NDJSON chat with a final counts frame', async () => {
    const app = createFakeOllama()
    const res = await app.request('http://fake.ollama/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'llama3.2:1b', messages: [] }),
    })
    const text = await res.text()
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
    const final = JSON.parse(lines[lines.length - 1])
    expect(final.done).toBe(true)
    expect(final.prompt_eval_count).toBe(11)
    expect(final.eval_count).toBe(22)
  })

  test('exposes /api/version', async () => {
    const res = await createFakeOllama().request('http://fake.ollama/api/version')
    expect(await res.json()).toEqual({ version: 'test' })
  })
})
