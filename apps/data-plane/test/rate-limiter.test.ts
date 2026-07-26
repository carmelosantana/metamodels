import { describe, expect, test } from 'vitest'
import { InMemoryRateLimiter } from '../src/ratelimit/rate-limiter.js'

describe('InMemoryRateLimiter', () => {
  test('allows up to max within the window, then blocks', async () => {
    let t = 1_000_000
    const rl = new InMemoryRateLimiter({ now: () => t })
    const limit = { windowSec: 60, max: 2 }
    expect((await rl.check('k', limit)).allowed).toBe(true)
    expect((await rl.check('k', limit)).allowed).toBe(true)
    const blocked = await rl.check('k', limit)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSec).toBeGreaterThan(0)
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(60)
  })

  test('separate buckets are independent', async () => {
    let t = 0
    const rl = new InMemoryRateLimiter({ now: () => t })
    const limit = { windowSec: 60, max: 1 }
    expect((await rl.check('a', limit)).allowed).toBe(true)
    expect((await rl.check('b', limit)).allowed).toBe(true)
    expect((await rl.check('a', limit)).allowed).toBe(false)
  })

  test('the window slides: old hits expire', async () => {
    let t = 0
    const rl = new InMemoryRateLimiter({ now: () => t })
    const limit = { windowSec: 10, max: 1 }
    expect((await rl.check('k', limit)).allowed).toBe(true)
    t = 11_000
    expect((await rl.check('k', limit)).allowed).toBe(true)
  })
})
