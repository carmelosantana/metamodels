import { withAdmin } from '../../../../../../server/admin-route'
import { getDb } from '../../../../../../server/db'
import { deleteFlock, getFlock, saveFlock } from '../../../../../../server/flocks-service'
import { readJsonObject } from '../../../../../../server/json-body'
import { parsePathId } from '../../../../../../server/path-id'

export const GET = withAdmin(async ({ actor, params }) =>
  Response.json(await getFlock(getDb(), actor, parsePathId(params.id))))

/**
 * PUT replaces every field a GET returns, because `saveFlock` does `set(values)`. The one exception
 * is `upstreamAuth`, which a GET never returns: omitted, it is left alone; `null` clears it. There is
 * deliberately no PATCH: a partial merge would have to read-modify-write outside the service's
 * transaction, where it races.
 */
export const PUT = withAdmin(async ({ actor, req, params }) => {
  // Before the body, not after: a path that names no resource makes the body moot (`path-id.ts`).
  const id = parsePathId(params.id)
  const body = await readJsonObject(req)
  const db = getDb()
  // A TENANCY GUARD, not a convenience. `saveFlock` happens to throw NotFoundError when its
  // org-scoped UPDATE matches no row, but a service whose save UPSERTS would instead CREATE a row
  // under this actor's org from another org's id. This read is the only thing that stops that.
  // Do not remove it when copying this module to another resource.
  await getFlock(db, actor, id)
  return Response.json(await saveFlock(db, actor, { ...body, id }))
}, { invalidates: 'flock.save' })

export const DELETE = withAdmin(async ({ actor, params }) => {
  await deleteFlock(getDb(), actor, parsePathId(params.id))
  return new Response(null, { status: 204 })
}, { invalidates: 'flock.delete' })
