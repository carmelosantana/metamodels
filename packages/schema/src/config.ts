import { z } from 'zod'
import { METER_DIMS } from './enums.js'

// Client-safe: imports only zod + the package's pure enums (no node:crypto, no drizzle).
// The single source of truth for a fence's rate-limit + quota config shapes, consumed by
// BOTH the control-plane (fence-schema.ts) and the data-plane (config/quota.ts).

/** A fence's `rate_limit` column: a sliding window cap. `max: 0` = deny-all (both planes honor it). */
export const rateLimitSchema = z.object({
  windowSec: z.number().int().positive(),
  max: z.number().int().nonnegative(),
})
export type RateLimitInput = z.infer<typeof rateLimitSchema>

/** One hard cap on a single meter dimension per period. */
export const quotaRuleSchema = z.object({
  dim: z.enum(METER_DIMS),
  max: z.number().int().nonnegative(),
  period: z.enum(['hour', 'day', 'month']),
})
export type QuotaRule = z.infer<typeof quotaRuleSchema>

/** A fence's `quota` column: a list of per-dimension caps. */
export const quotaSchema = z.array(quotaRuleSchema)
