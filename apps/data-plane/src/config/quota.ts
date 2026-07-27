import { z } from 'zod'
import { METER_DIMS } from '@metamodels/schema'

export const quotaRuleSchema = z.object({
  dim: z.enum(METER_DIMS),
  max: z.number().int().nonnegative(),
  period: z.enum(['hour', 'day', 'month']),
})

/** A fence's `quota` column: a list of hard caps, each on one dimension per period. */
export const quotaSchema = z.array(quotaRuleSchema)

export type QuotaRule = z.infer<typeof quotaRuleSchema>
