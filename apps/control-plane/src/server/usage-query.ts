import { z } from 'zod'
import { METER_DIMS } from '@metamodels/schema'
import { isBucket } from '../lib/usage-range'

/**
 * The query strings of the three usage reports (spec §3), parsed once here rather than three times
 * in three route modules — the same instinct as `readJsonObject`: a caller-supplied value that
 * reaches a service unchecked is an opaque 500 waiting to happen, and a check that has to be
 * remembered in every handler eventually is not.
 *
 * `problemForError` maps `ZodError` to 422, so every failure below is already the right status.
 *
 * These reports are NOT resources: no `limit`/`cursor` pagination and no `Link` header. The only
 * `limit` here is `topKeys`'s own N-of-a-ranking parameter, which is why it lives on one schema and
 * not all three, and why it has a different maximum from `page.ts`'s.
 */

/** A `usage_rollup.period` hour bucket. Round-tripped through `periodBucket` — see `isBucket`. */
const bucketSchema = z.string().refine(isBucket, {
  message: 'expected a UTC hour bucket in the form YYYY-MM-DDTHH',
})

/**
 * `keyId` and `paddockId` are compared against uuid COLUMNS. Postgres rejects an invalid uuid
 * literal with a driver error `problemForError` cannot map, so without `.uuid()` here a client
 * typing a key's name where its id belongs gets a 500 that blames the server.
 */
const rangeShape = {
  startBucket: bucketSchema,
  endBucket: bucketSchema,
  keyId: z.string().uuid().optional(),
  paddockId: z.string().uuid().optional(),
}

const dimSchema = z.enum(METER_DIMS)

export const matrixQuery = z.object(rangeShape)

export const dailyQuery = z.object({ ...rangeShape, dim: dimSchema })

export const topKeysQuery = z.object({
  startBucket: bucketSchema,
  endBucket: bucketSchema,
  dim: dimSchema,
  // Rejected rather than clamped, for `parsePageOpts`'s reason: silently returning a different
  // number of rows than asked for is a lie a client acts on. `limit` also reaches SQL's LIMIT
  // directly, where `abc` is a driver error and `0` is a request for nothing.
  limit: z.coerce.number().int().min(1).max(100).default(10),
})

/**
 * `searchParams` as a plain object, dropping absent keys so `.optional()` and `.default()` behave.
 *
 * `URLSearchParams.get` returns the FIRST value for a repeated key; `Object.fromEntries` over the
 * entries keeps the LAST. Neither is more correct, but they must not disagree between routes, so
 * the choice is made once, here: first wins, matching `parsePageOpts`.
 */
export function queryOf(url: URL): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of url.searchParams) if (!(k in out)) out[k] = v
  return out
}
