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
  // OPTIONAL, and deliberately NOT defaulted. Spec §3 makes status a PUT sub-resource routed at
  // `setPaddockStatus`, so the admin API's item PUT must leave an existing paddock's status alone.
  // A `.default('active')` here would make an omitted status an active WRITE, which on update
  // re-enables a paddock somebody disabled on purpose. Omission now means "do not touch it":
  // `savePaddock` leaves the column out of its `set()`, and on INSERT the column's own
  // `notNull().default('active')` (packages/schema/src/schema.ts) supplies the create default.
  status: z.enum(PADDOCK_STATUS).optional(),
  theme: z.enum(PADDOCK_THEMES).default('plain'),
})

export type SavePaddockInput = z.infer<typeof savePaddockInput>
