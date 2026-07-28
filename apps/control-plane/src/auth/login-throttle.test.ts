import { describe, expect, test } from 'vitest'
import { LoginThrottle } from './login-throttle'

describe('LoginThrottle', () => {
  test('blocks after 5 failures in the window, resets after it elapses', () => {
    const t = new LoginThrottle()
    let now = 0
    for (let i = 0; i < 5; i++) { expect(t.check('1.2.3.4', now)).toBe(true); t.record('1.2.3.4', now) }
    expect(t.check('1.2.3.4', now)).toBe(false)            // 6th blocked
    expect(t.check('9.9.9.9', now)).toBe(true)             // other IP unaffected
    now += 15 * 60_000 + 1
    expect(t.check('1.2.3.4', now)).toBe(true)             // window elapsed
  })
})
