import { withAdmin } from '../../../../../../server/admin-route'
import { getDb } from '../../../../../../server/db'
import { readJsonObject } from '../../../../../../server/json-body'
import { deletePaddock, getPaddock, savePaddock } from '../../../../../../server/paddocks-service'
import { parsePathId } from '../../../../../../server/path-id'

export const GET = withAdmin(async ({ actor, params }) =>
  Response.json(await getPaddock(getDb(), actor, parsePathId(params.id))))

/**
 * PUT is a full replace, because `savePaddock` does `set(values)`. There is deliberately no PATCH:
 * a partial merge would have to read-modify-write outside the service's transaction, where it races.
 *
 * `status` is the ONE exception, and it is READ-ONLY here rather than merged. Spec §3 makes status
 * a PUT sub-resource routed at `setPaddockStatus`, "not a field of the main PUT" — a rename must
 * not flip a deliberately-thrown kill switch back on. So the field is dropped from the body before
 * the service sees it, and `savePaddock` leaves the column out of its `set()` entirely. Untouched
 * INSIDE the service's transaction, not read here and re-asserted after: a read-modify-write across
 * two transactions would lose a concurrent PUT /{id}/status, which is the same re-enable narrowed
 * to a race window rather than removed.
 *
 * Drop-and-ignore rather than 422-on-`status`: `GET` returns the field, so rejecting it would
 * break the natural GET → change one field → PUT round trip on a field the client never touched.
 */
export const PUT = withAdmin(async ({ actor, req, params }) => {
  // Before the body, not after: a path that names no resource makes the body moot (`path-id.ts`).
  const id = parsePathId(params.id)
  const body = await readJsonObject(req)
  // `status` is read-only on this endpoint (spec §3): dropped before the service ever sees it,
  // so an omitted status and a supplied one take exactly the same path.
  delete body.status
  const db = getDb()
  // A TENANCY GUARD, not a convenience. `savePaddock` happens to throw NotFoundError when its
  // org-scoped UPDATE matches no row, but a service whose save UPSERTS would instead CREATE a row
  // under this actor's org from another org's id. This read is the only thing that stops that.
  // Do not remove it when copying this module to another resource.
  await getPaddock(db, actor, id)
  return Response.json(await savePaddock(db, actor, { ...body, id }))
})

export const DELETE = withAdmin(async ({ actor, params }) => {
  await deletePaddock(getDb(), actor, parsePathId(params.id))
  return new Response(null, { status: 204 })
})
