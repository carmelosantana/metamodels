import { withAdmin } from '../../../../../../server/admin-route'
import { getDb } from '../../../../../../server/db'
import { dailySeries } from '../../../../../../server/usage-service'
import { dailyQuery, queryOf } from '../../../../../../server/usage-query'

/**
 * One meter dimension grouped by UTC day. `dim` is REQUIRED and has no default: the console picks
 * `tokens_out` for its headline chart (`src/app/(app)/usage/page.tsx`), but a default here would be
 * this route quietly answering a question the caller did not ask, and the five dims are not
 * interchangeable — `gpu_ms` and `images` are not tokens.
 *
 * The series is SPARSE: `dailySeries` returns only the days that have rows, so a client wanting a
 * dense axis fills the gaps itself, exactly as the console page does. No `Link`, no pagination —
 * see `../matrix/route.ts`.
 */
export const GET = withAdmin(async ({ actor, req }) => {
  const q = dailyQuery.parse(queryOf(new URL(req.url)))
  return Response.json(await dailySeries(getDb(), actor, q))
})
