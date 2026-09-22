import { z } from 'zod'
import { PADDOCK_STATUS } from '@metamodels/schema'
import { withAdmin } from '../../../../../../../server/admin-route'
import { getDb } from '../../../../../../../server/db'
import { readJsonObject } from '../../../../../../../server/json-body'
import { setPaddockStatus } from '../../../../../../../server/paddocks-service'

const statusBody = z.object({ status: z.enum(PADDOCK_STATUS) })

/**
 * A sub-resource rather than a field of the main PUT. Flipping a paddock off is the one-field
 * operation an operator reaches for most, and routing it through `savePaddock` would make it
 * require the whole representation (flockId, name, slug, theme) and audit as `paddock.update`.
 * `setPaddockStatus` exists to write `paddock.status` instead, and the console's paddock action
 * (`src/app/(app)/paddocks/actions.ts`) already reaches it — this route is the same operation
 * over HTTP, so both surfaces emit the same audit action.
 *
 * No `getPaddock` guard precedes it: `setPaddockStatus` is an org-scoped UPDATE, not an upsert,
 * and throws NotFoundError when it matches no row — so a foreign id cannot create anything.
 */
export const PUT = withAdmin(async ({ actor, req, params }) => {
  const { status } = statusBody.parse(await readJsonObject(req))
  return Response.json(await setPaddockStatus(getDb(), actor, params.id, status))
})
