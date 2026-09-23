import { z } from 'zod'
import { METER_DIMS } from '@metamodels/schema'
import { isBucket } from '../lib/usage-range'
import { uuidSchema } from './path-id'

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
 * literal with a driver error `problemForError` cannot map, so without this a client typing a key's
 * name where its id belongs gets a 500 that blames the server.
 *
 * `uuidSchema` is imported from `path-id.ts` rather than rewritten: that module is the one
 * definition of what an id is in this API, and a second `z.string().uuid()` here would be a second
 * one waiting to drift.
 */
const rangeShape = {
  startBucket: bucketSchema,
  endBucket: bucketSchema,
  keyId: uuidSchema.optional(),
  paddockId: uuidSchema.optional(),
}

const dimSchema = z.enum(METER_DIMS)

/**
 * The window must run forwards. Both buckets can be well-formed and still describe nothing: every
 * `period >= start AND period <= end` comparison is false, so the service truthfully returns no
 * rows and the report answers `200 []` — telling the caller they used nothing over a window that
 * ran backwards. That is the claim `isBucket` exists to prevent, arriving by another route.
 *
 * Lexicographic `<=` is exact here, not an approximation: `YYYY-MM-DDTHH` is fixed-width,
 * zero-padded and most-significant-first, so string order IS chronological order. Equal bounds are
 * legal — that is a one-hour window, and a real question to ask.
 *
 * The issue is reported on `endBucket` because that is the bound a caller sweeping a range forward
 * most often gets wrong, and naming one field beats an issue with no path at all.
 */
const rangeRunsForwards = (q: { startBucket: string; endBucket: string }) => q.startBucket <= q.endBucket
const RANGE_ORDER_ISSUE: Partial<Omit<z.ZodCustomIssue, 'code'>> = {
  path: ['endBucket'],
  message: 'endBucket must not be earlier than startBucket',
}

export const matrixQuery = z.object(rangeShape).refine(rangeRunsForwards, RANGE_ORDER_ISSUE)

export const dailyQuery = z
  .object({ ...rangeShape, dim: dimSchema })
  .refine(rangeRunsForwards, RANGE_ORDER_ISSUE)

export const topKeysQuery = z
  .object({
    startBucket: bucketSchema,
    endBucket: bucketSchema,
    dim: dimSchema,
    // Rejected rather than clamped, for `parsePageOpts`'s reason: silently returning a different
    // number of rows than asked for is a lie a client acts on. `limit` also reaches SQL's LIMIT
    // directly, where `abc` is a driver error and `0` is a request for nothing.
    limit: z.coerce.number().int().min(1).max(100).default(10),
  })
  .refine(rangeRunsForwards, RANGE_ORDER_ISSUE)

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
