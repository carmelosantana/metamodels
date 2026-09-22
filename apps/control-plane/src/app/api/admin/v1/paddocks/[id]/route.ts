import { withAdmin } from '../../../../../../server/admin-route'
import { getDb } from '../../../../../../server/db'
import { readJsonObject } from '../../../../../../server/json-body'
import { deletePaddock, getPaddock, savePaddock } from '../../../../../../server/paddocks-service'

export const GET = withAdmin(async ({ actor, params }) =>
  Response.json(await getPaddock(getDb(), actor, params.id)))

/**
 * PUT is a full replace, because `savePaddock` does `set(values)`. There is deliberately no PATCH:
 * a partial merge would have to read-modify-write outside the service's transaction, where it races.
 *
 * `status` IS accepted here, but `savePaddockInput` defaults it to 'active' when it is omitted —
 * so a replace that does not name a status re-enables a disabled paddock. That follows from
 * full-replace and is deliberate; PUT /paddocks/{id}/status is how a status is flipped without
 * resending the whole representation. `admin-paddocks.test.ts` pins the re-enabling case.
 */
export const PUT = withAdmin(async ({ actor, req, params }) => {
  const body = await readJsonObject(req)
  const db = getDb()
  // A TENANCY GUARD, not a convenience. `savePaddock` happens to throw NotFoundError when its
  // org-scoped UPDATE matches no row, but a service whose save UPSERTS would instead CREATE a row
  // under this actor's org from another org's id. This read is the only thing that stops that.
  // Do not remove it when copying this module to another resource.
  await getPaddock(db, actor, params.id)
  return Response.json(await savePaddock(db, actor, { ...body, id: params.id }))
})

export const DELETE = withAdmin(async ({ actor, params }) => {
  await deletePaddock(getDb(), actor, params.id)
  return new Response(null, { status: 204 })
})
