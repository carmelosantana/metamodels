import { withAdmin } from '../../../../../../server/admin-route'
import { getDb } from '../../../../../../server/db'
import { usageMatrix } from '../../../../../../server/usage-service'
import { matrixQuery, queryOf } from '../../../../../../server/usage-query'

/**
 * A report, not a resource (spec §3): the key×paddock pivot `usageMatrix` already builds, returned
 * unchanged. Deliberately NO `limit`/`cursor` and NO `Link` header — the collection routes' one
 * cursor line is not copied here. A cursor is a promise that the rows have a stable total order to
 * resume from; this body is a pivot recomputed per request over a caller-chosen window, so there is
 * nothing for a cursor to point at.
 *
 * `read` is enforced by `usageMatrix` itself, not re-asserted here, so the route cannot drift from
 * the capability the service actually requires.
 */
export const GET = withAdmin(async ({ actor, req }) => {
  const q = matrixQuery.parse(queryOf(new URL(req.url)))
  return Response.json(await usageMatrix(getDb(), actor, q))
})
