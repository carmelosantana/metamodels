import { z } from 'zod'
import { PADDOCK_STATUS, PADDOCK_THEMES } from '@metamodels/schema'

// Public /p/:slug handle: lowercase letters, digits, hyphens; no leading/trailing hyphen.
const slug = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'slug must be lowercase letters, digits, and hyphens')

export const savePaddockInput = z.object({
  id: z.string().uuid().optional(),
  flockId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  slug,
  status: z.enum(PADDOCK_STATUS).default('active'),
  theme: z.enum(PADDOCK_THEMES).default('plain'),
})

export type SavePaddockInput = z.infer<typeof savePaddockInput>
