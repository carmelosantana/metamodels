import { z } from 'zod'
import { rateLimitSchema } from '@metamodels/schema/config'

/** Optional per-key overrides. Mirrors the data-plane `KeyOverrides` shape ({ rateLimit? }). */
export const keyOverridesSchema = z.object({
  rateLimit: rateLimitSchema,
}).partial()

export const createKeyInput = z.object({
  name: z.string().min(1).max(120),
  // At least one org-owned paddock. Org consistency is enforced in the service, not here.
  paddockIds: z.array(z.string().uuid()).min(1),
  expiresAt: z.string().datetime().optional(),
  overrides: keyOverridesSchema.optional(),
})
export type CreateKeyInput = z.infer<typeof createKeyInput>
