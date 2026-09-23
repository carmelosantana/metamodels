import { z } from 'zod'
import { BREED_IDS } from '@metamodels/schema'

/**
 * `upstreamAuth` is a bare token: every call to the flock sends `Authorization: Bearer <token>`. No
 * whitespace, so no scheme (`Bearer abc` would go up as `Bearer Bearer abc`), and no control
 * character, so no CR/LF header injection. Shared with the OpenAPI mirror, which publishes it.
 */
export const UPSTREAM_AUTH_PATTERN = /^[^\s\x00-\x1f\x7f]+$/
export const UPSTREAM_AUTH_MESSAGE =
  'Paste the token only: no "Bearer " or other scheme, no spaces. It is sent as "Authorization: Bearer <token>".'

export const saveFlockInput = z.object({
  id: z.string().uuid().optional(),
  breed: z.enum(BREED_IDS),
  name: z.string().trim().min(1).max(120),
  baseUrl: z.string().url(),
  // Tri-state, and the distinction is load-bearing: omitted leaves a stored credential untouched
  // (`saveFlock` keeps the column out of its UPDATE), `null` clears it, a string replaces it. No read
  // returns the credential, so an omitted field is what every GET → edit → PUT round trip sends.
  // Do not `.default()` it: that would turn omission into a write and clear it on every edit.
  upstreamAuth: z.string().trim().min(1).regex(UPSTREAM_AUTH_PATTERN, UPSTREAM_AUTH_MESSAGE).nullish(),
  tlsTrust: z.boolean(),
})

export type SaveFlockInput = z.infer<typeof saveFlockInput>

export const flockConnectionInput = saveFlockInput.pick({
  breed: true, baseUrl: true, upstreamAuth: true, tlsTrust: true,
})
export type FlockConnectionInput = z.infer<typeof flockConnectionInput>
