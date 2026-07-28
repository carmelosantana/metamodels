import { z } from 'zod'
import { rateLimitSchema, quotaSchema } from '@metamodels/schema/config'

export { rateLimitSchema, quotaSchema }
export type RateLimitInput = z.infer<typeof rateLimitSchema>
export type QuotaRuleInput = z.infer<typeof quotaSchema.element>

export const saveFenceInput = z.object({
  paddockId: z.string().uuid(),
  // Optional: when omitted, saveFence preserves the fence's stored constraint
  // (or applies the breed default on a fresh row). Validated per-breed on write.
  constraintJson: z.unknown().optional(),
  rateLimit: rateLimitSchema.nullish(),
  quota: quotaSchema.nullish(),
})
export type SaveFenceInput = z.infer<typeof saveFenceInput>
