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
 * `status` is the ONE exception, and it is not a merge: it is READ-ONLY on this endpoint. Spec §3
 * makes status a PUT sub-resource routed at `setPaddockStatus`, "not a field of the main PUT" —
 * but `savePaddockInput` defaults it to 'active', so a replace that simply leaves it out would
 * write 'active' and silently re-enable a paddock an operator disabled on purpose. A rename must
 * not flip the kill switch back on. So the current status is read here and carried through,
 * overriding whatever the body says.
 *
 * Preserve-and-ignore rather than 422-on-`status`: `GET` returns the field, so rejecting it would
 * break the natural GET → change one field → PUT round trip on a field the client never touched.
 */
export const PUT = withAdmin(async ({ actor, req, params }) => {
  const body = await readJsonObject(req)
  const db = getDb()
  // A TENANCY GUARD, not a convenience. `savePaddock` happens to throw NotFoundError when its
  // org-scoped UPDATE matches no row, but a service whose save UPSERTS would instead CREATE a row
  // under this actor's org from another org's id. This read is the only thing that stops that.
  // Do not remove it when copying this module to another resource. It also supplies the status.
  const current = await getPaddock(db, actor, params.id)
  // `status` LAST: it must win over the body, not be defaulted by its absence.
  return Response.json(await savePaddock(db, actor, {
    ...body, id: params.id, status: current.status,
  }))
})

export const DELETE = withAdmin(async ({ actor, params }) => {
  await deletePaddock(getDb(), actor, params.id)
  return new Response(null, { status: 204 })
})
