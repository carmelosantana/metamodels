import { withAdmin } from '../../../../../../../server/admin-route'
import { getDb } from '../../../../../../../server/db'
import { getFence, saveFence } from '../../../../../../../server/fences-service'
import { buildBreedRegistry } from '../../../../../../../server/flock-health'
import { readJsonObject } from '../../../../../../../server/json-body'
import { problem } from '../../../../../../../server/problem'

// One registry per module, exactly as the console's fence action does it
// (`src/app/(app)/paddocks/[id]/fence/actions.ts`). It is a stateless map of breed id to breed, so
// a second instance would only be a second copy of the same two registrations — and the two
// surfaces MUST validate a constraint against the same set of breeds or the console and the API
// disagree about what a fence may say.
const registry = buildBreedRegistry()

export const GET = withAdmin(async ({ actor, params }) => {
  const found = await getFence(getDb(), actor, params.id)
  // A paddock with no fence has no fence resource. 200 with a `null` body would tell a client the
  // resource exists and is empty, which is a different thing and one it cannot act on.
  // (An out-of-org paddock never reaches here — `getFence` throws NotFoundError first.)
  if (!found) return problem(404, 'Not Found', `fence for paddock ${params.id}`)
  return Response.json(found)
})

/**
 * PUT creates or replaces the paddock's single fence. No `getFence` guard precedes it — unlike the
 * item PUT, an absent row here is the create case, so a pre-read would forbid the only way to make
 * a fence. The tenancy guard instead lives INSIDE `saveFence`, at the `paddockBreedInOrg` call that
 * opens its transaction: it is atomic with the upsert, which a route-level read could not be.
 *
 * ⚠ THIS PUT IS NOT A UNIFORM FULL REPLACE. `saveFence` treats the three fields differently, and
 * a caller has to know which is which because this is the resource that holds the allow-list:
 *
 *   - `constraintJson` omitted → the stored constraint is PRESERVED (or, on a fresh row, the
 *     breed default is applied). It is a merge. A client trying to reset a constraint by sending
 *     a body without one silently keeps the old allow-list.
 *   - `rateLimit` and `quota` omitted → both are set to NULL. Those are replaced.
 *
 * The asymmetry is `saveFence`'s, deliberate, and load-bearing for the console's comfyui path,
 * where templates are managed on their own screen and the fence form must not clobber them
 * (`src/app/(app)/paddocks/[id]/fence/actions.ts` omits `constraintJson` for exactly that reason).
 * It is NOT this route's to change. What this route owes is that the contract is written down and
 * pinned: `admin-paddocks.test.ts` asserts both halves against an existing fence, so a later
 * change to either one fails rather than passing silently. Task 10 documents it for clients.
 */
export const PUT = withAdmin(async ({ actor, req, params }) => {
  const body = await readJsonObject(req)
  // The path owns the paddock id; a `paddockId` in the body is overwritten, never trusted.
  const saved = await saveFence(getDb(), actor, registry, { ...body, paddockId: params.id })
  return Response.json(saved)
})
