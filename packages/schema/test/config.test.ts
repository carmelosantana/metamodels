import { describe, expect, test } from 'vitest'
import { rateLimitSchema, quotaRuleSchema, quotaSchema } from '../src/config.js'

describe('config schemas', () => {
  test('rateLimitSchema accepts a positive window + nonnegative max', () => {
    expect(rateLimitSchema.safeParse({ windowSec: 60, max: 100 }).success).toBe(true)
    expect(rateLimitSchema.safeParse({ windowSec: 60, max: 0 }).success).toBe(true)
  })

  test('rateLimitSchema rejects a non-positive window and a fractional max', () => {
    expect(rateLimitSchema.safeParse({ windowSec: 0, max: 1 }).success).toBe(false)
    expect(rateLimitSchema.safeParse({ windowSec: 60, max: 1.5 }).success).toBe(false)
    expect(rateLimitSchema.safeParse({ windowSec: 60, max: -1 }).success).toBe(false)
  })

  test('quotaRuleSchema binds a known meter dim + period', () => {
    expect(quotaRuleSchema.safeParse({ dim: 'tokens_in', max: 1000, period: 'day' }).success).toBe(true)
    expect(quotaRuleSchema.safeParse({ dim: 'not_a_dim', max: 1000, period: 'day' }).success).toBe(false)
    expect(quotaRuleSchema.safeParse({ dim: 'tokens_in', max: 1000, period: 'week' }).success).toBe(false)
  })

  test('quotaSchema is a list of rules', () => {
    expect(quotaSchema.safeParse([{ dim: 'jobs', max: 5, period: 'hour' }]).success).toBe(true)
    expect(quotaSchema.safeParse([]).success).toBe(true)
  })
})
