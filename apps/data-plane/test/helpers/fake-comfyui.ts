import { Hono } from 'hono'

/**
 * A Hono app simulating just enough of ComfyUI for the data-plane integration
 * test, exposed as a `fetchImpl`-shaped `request`.
 *
 * - `POST /prompt`        → `{ prompt_id: 'cf-1' }`
 * - `POST /upload/image`  → `{ name: 'uploaded.png' }`
 * - `GET  /history/:id`   → `{}` while the job is pending; a completed history
 *                           (status.completed, two output images, and
 *                           execution_start→execution_success timestamps) once
 *                           the test flips it complete via `complete(id)`.
 *
 * Completion is controlled by the test through the mutable `completed` set, so a
 * poll before completion and after completion can be exercised deterministically.
 */
export interface FakeComfyui {
  request: (url: string, init?: RequestInit) => Promise<Response>
  /** Flip a job (default `cf-1`) from pending → complete. */
  complete: (jobId?: string) => void
}

// Fixed timestamps → deterministic gpu_ms = 500.
const EXEC_START = 1_000_000
const EXEC_SUCCESS = 1_000_500

export function createFakeComfyui(): FakeComfyui {
  const completed = new Set<string>()
  const app = new Hono()

  app.post('/prompt', (c) => c.json({ prompt_id: 'cf-1' }))
  app.post('/upload/image', (c) => c.json({ name: 'uploaded.png' }))

  app.get('/history/:id', (c) => {
    const id = c.req.param('id')
    if (!completed.has(id)) return c.json({})
    return c.json({
      [id]: {
        status: {
          status_str: 'success',
          completed: true,
          messages: [
            ['execution_start', { prompt_id: id, timestamp: EXEC_START }],
            ['execution_success', { prompt_id: id, timestamp: EXEC_SUCCESS }],
          ],
        },
        outputs: {
          '9': {
            images: [
              { filename: 'out-1.png', subfolder: '', type: 'output' },
              { filename: 'out-2.png', subfolder: '', type: 'output' },
            ],
          },
        },
      },
    })
  })

  return {
    request: (url, init) => app.request(url, init ?? {}),
    complete: (jobId = 'cf-1') => {
      completed.add(jobId)
    },
  }
}
