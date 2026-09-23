import { z } from 'zod'
import { BREED_IDS } from '@metamodels/schema'

export const saveFlockInput = z.object({
  id: z.string().uuid().optional(),
  breed: z.enum(BREED_IDS),
  name: z.string().trim().min(1).max(120),
  baseUrl: z.string().url(),
  // Tri-state, and the distinction is load-bearing: omitted leaves a stored credential untouched
  // (`saveFlock` keeps the column out of its UPDATE), `null` clears it, a string replaces it. No read
  // returns the credential, so an omitted field is what every GET → edit → PUT round trip sends.
  // Do not `.default()` it: that would turn omission into a write and clear it on every edit.
  upstreamAuth: z.string().trim().min(1).nullish(),
  tlsTrust: z.boolean(),
})

export type SaveFlockInput = z.infer<typeof saveFlockInput>

export const flockConnectionInput = saveFlockInput.pick({
  breed: true, baseUrl: true, upstreamAuth: true, tlsTrust: true,
})
export type FlockConnectionInput = z.infer<typeof flockConnectionInput>
