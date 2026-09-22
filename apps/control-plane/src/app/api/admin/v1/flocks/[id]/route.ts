import { withAdmin } from '../../../../../../server/admin-route'
import { getDb } from '../../../../../../server/db'
import { deleteFlock, getFlock, saveFlock } from '../../../../../../server/flocks-service'

export const GET = withAdmin(async ({ actor, params }) =>
  Response.json(await getFlock(getDb(), actor, params.id)))

/**
 * PUT is a full replace, because `saveFlock` does `set(values)`. There is deliberately no PATCH:
 * a partial merge would have to read-modify-write outside the service's transaction, where it races.
 */
export const PUT = withAdmin(async ({ actor, req, params }) => {
  const body = await req.json() as Record<string, unknown>
  const db = getDb()
  await getFlock(db, actor, params.id)          // 404 before any write if it is not ours
  return Response.json(await saveFlock(db, actor, { ...body, id: params.id }))
})

export const DELETE = withAdmin(async ({ actor, params }) => {
  await deleteFlock(getDb(), actor, params.id)
  return new Response(null, { status: 204 })
})
