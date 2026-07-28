import { z } from 'zod'
import { BREED_IDS } from '@metamodels/schema'

export const saveFlockInput = z.object({
  id: z.string().uuid().optional(),
  breed: z.enum(BREED_IDS),
  name: z.string().trim().min(1).max(120),
  baseUrl: z.string().url(),
  upstreamAuth: z.string().trim().min(1).nullish(),
  tlsTrust: z.boolean(),
})

export type SaveFlockInput = z.infer<typeof saveFlockInput>

export const flockConnectionInput = saveFlockInput.pick({
  breed: true, baseUrl: true, upstreamAuth: true, tlsTrust: true,
})
export type FlockConnectionInput = z.infer<typeof flockConnectionInput>
