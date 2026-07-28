import { z } from 'zod'
import { METER_DIMS } from '@metamodels/schema'

// Shape matches the data-plane's RateLimit ({windowSec,max}) and quotaSchema.
export const rateLimitSchema = z.object({
  windowSec: z.number().int().positive(),
  max: z.number().int().nonnegative(),
})
export type RateLimitInput = z.infer<typeof rateLimitSchema>

export const quotaRuleSchema = z.object({
  dim: z.enum(METER_DIMS),
  max: z.number().int().nonnegative(),
  period: z.enum(['hour', 'day', 'month']),
})
export const quotaSchema = z.array(quotaRuleSchema)
export type QuotaRuleInput = z.infer<typeof quotaRuleSchema>

export const saveFenceInput = z.object({
  paddockId: z.string().uuid(),
  // Optional: when omitted, saveFence preserves the fence's stored constraint
  // (or applies the breed default on a fresh row). Validated per-breed on write.
  constraintJson: z.unknown().optional(),
  rateLimit: rateLimitSchema.nullish(),
  quota: quotaSchema.nullish(),
})
export type SaveFenceInput = z.infer<typeof saveFenceInput>
