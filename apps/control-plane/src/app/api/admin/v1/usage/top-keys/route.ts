import { withAdmin } from '../../../../../../server/admin-route'
import { getDb } from '../../../../../../server/db'
import { topKeys } from '../../../../../../server/usage-service'
import { queryOf, topKeysQuery } from '../../../../../../server/usage-query'

/**
 * The org's keys ranked by one dimension over the window. `limit` here is the N of a ranking, NOT
 * pagination: `topKeys` orders by `sum(value) DESC` with no tiebreak and no cursor, so there is no
 * "next page" of a top-10 to follow and no `Link` header to emit (spec §3).
 *
 * `keyId` and `paddockId` are absent from this schema on purpose, unlike the other two reports:
 * `topKeys` accepts neither, and a parameter parsed here and then dropped on the floor would read
 * to a client — and to Task 10's generated document — as a filter that works.
 */
export const GET = withAdmin(async ({ actor, req }) => {
  const q = topKeysQuery.parse(queryOf(new URL(req.url)))
  return Response.json(await topKeys(getDb(), actor, q))
})
