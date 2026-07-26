import { describe, expect, test } from 'vitest'
import { parseHistory } from '../src/comfyui/result.js'

// A history object shaped like ComfyUI's GET /history/{prompt_id} response:
// { [promptId]: { status: { completed, messages: [...] }, outputs: { [nodeId]: { images: [...] } } } }
// Messages are tuples: ["execution_start", { prompt_id, timestamp }] etc. (timestamps in ms).
function completedHistory(promptId: string) {
  return {
    [promptId]: {
      status: {
        status_str: 'success',
        completed: true,
        messages: [
          ['execution_start', { prompt_id: promptId, timestamp: 1_000_000 }],
          ['execution_cached', { nodes: [], prompt_id: promptId, timestamp: 1_000_050 }],
          ['execution_success', { prompt_id: promptId, timestamp: 1_002_500 }],
        ],
      },
      outputs: {
        '9': {
          images: [
            { filename: 'ComfyUI_00001_.png', subfolder: '', type: 'output' },
          ],
        },
        '12': {
          images: [
            { filename: 'ComfyUI_00002_.png', subfolder: 'batch', type: 'output' },
          ],
        },
      },
    },
  }
}

describe('parseHistory', () => {
  test('a completed job yields done, both images across nodes, and positive gpuMs', () => {
    const promptId = 'abc-123'
    const outcome = parseHistory(completedHistory(promptId), promptId)
    expect(outcome.done).toBe(true)
    expect(outcome.images).toHaveLength(2)
    expect(outcome.images).toContainEqual({
      filename: 'ComfyUI_00001_.png',
      subfolder: '',
      type: 'output',
    })
    expect(outcome.images).toContainEqual({
      filename: 'ComfyUI_00002_.png',
      subfolder: 'batch',
      type: 'output',
    })
    // 1_002_500 - 1_000_000
    expect(outcome.gpuMs).toBe(2500)
    expect(outcome.gpuMs).toBeGreaterThan(0)
  })

  test('an absent prompt id yields a safe not-done outcome', () => {
    const outcome = parseHistory(completedHistory('abc-123'), 'nope')
    expect(outcome).toEqual({ done: false, images: [], gpuMs: 0 })
  })

  test('an empty history object yields a safe not-done outcome', () => {
    const outcome = parseHistory({}, 'abc-123')
    expect(outcome).toEqual({ done: false, images: [], gpuMs: 0 })
  })

  test('a not-yet-completed job is not done but still parses safely', () => {
    const promptId = 'pending-1'
    const history = {
      [promptId]: {
        status: { completed: false, messages: [['execution_start', { timestamp: 5 }]] },
        outputs: {},
      },
    }
    const outcome = parseHistory(history, promptId)
    expect(outcome.done).toBe(false)
    expect(outcome.images).toEqual([])
    expect(outcome.gpuMs).toBe(0)
  })

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a string', 'not history'],
    ['an array', []],
    ['empty object', {}],
    ['entry missing status', { x: { outputs: {} } }],
    ['status not an object', { x: { status: 'done', outputs: {} } }],
    ['messages not an array', { x: { status: { completed: true, messages: 'nope' } } }],
    ['outputs not an object', { x: { status: { completed: true }, outputs: 7 } }],
    ['images not an array', { x: { status: { completed: true }, outputs: { '1': { images: {} } } } }],
    ['image entry not an object', { x: { status: { completed: true }, outputs: { '1': { images: [null, 5] } } } }],
  ])('malformed input (%s) does not throw and yields a safe outcome', (_label, input) => {
    let outcome!: ReturnType<typeof parseHistory>
    expect(() => {
      outcome = parseHistory(input, 'x')
    }).not.toThrow()
    expect(outcome.done === true || outcome.done === false).toBe(true)
    expect(Array.isArray(outcome.images)).toBe(true)
    expect(typeof outcome.gpuMs).toBe('number')
    expect(outcome.gpuMs).toBeGreaterThanOrEqual(0)
  })

  test('image entries without a string filename are skipped', () => {
    const promptId = 'p'
    const history = {
      [promptId]: {
        status: { completed: true, messages: [] },
        outputs: {
          '1': {
            images: [
              { filename: 'good.png', subfolder: '', type: 'output' },
              { subfolder: 'x', type: 'output' }, // no filename
              { filename: 42, subfolder: 'x', type: 'output' }, // non-string filename
            ],
          },
        },
      },
    }
    const outcome = parseHistory(history, promptId)
    expect(outcome.images).toEqual([{ filename: 'good.png', subfolder: '', type: 'output' }])
  })

  test('missing timestamps yield gpuMs 0', () => {
    const promptId = 'p'
    const history = {
      [promptId]: {
        status: {
          completed: true,
          messages: [
            ['execution_start', { prompt_id: promptId }], // no timestamp
            ['execution_success', { prompt_id: promptId }], // no timestamp
          ],
        },
        outputs: {},
      },
    }
    expect(parseHistory(history, promptId).gpuMs).toBe(0)
  })

  test('only a start message (no success) yields gpuMs 0', () => {
    const promptId = 'p'
    const history = {
      [promptId]: {
        status: {
          completed: false,
          messages: [['execution_start', { prompt_id: promptId, timestamp: 100 }]],
        },
        outputs: {},
      },
    }
    expect(parseHistory(history, promptId).gpuMs).toBe(0)
  })

  test('negative duration (success before start) is clamped to 0', () => {
    const promptId = 'p'
    const history = {
      [promptId]: {
        status: {
          completed: true,
          messages: [
            ['execution_start', { prompt_id: promptId, timestamp: 500 }],
            ['execution_success', { prompt_id: promptId, timestamp: 100 }],
          ],
        },
        outputs: {},
      },
    }
    expect(parseHistory(history, promptId).gpuMs).toBe(0)
  })
})
