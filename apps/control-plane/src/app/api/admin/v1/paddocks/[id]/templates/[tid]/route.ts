import { withAdmin } from '../../../../../../../../server/admin-route'
import { getDb } from '../../../../../../../../server/db'
import { readJsonObject } from '../../../../../../../../server/json-body'
import { deleteTemplate, saveTemplate } from '../../../../../../../../server/templates-service'
import { parsePathId } from '../../../../../../../../server/path-id'

/**
 * PUT replaces the template the PATH names. `saveTemplate` keys on the draft's `id` — it replaces a
 * matching template and APPENDS a non-matching one — so the path id is forced onto the body last.
 * Without that, `PUT /templates/txt2img` with a body saying `id: "img2img"` would silently create a
 * second template instead of replacing the one addressed, and answer 200 as if it had replaced it.
 *
 * As on the collection, the 200 body is the whole array, because that is what the service returns.
 * The tenancy guard is inside `saveTemplate`'s transaction (see `../route.ts`), not out here.
 */
export const PUT = withAdmin(async ({ actor, req, params }) => {
  // `{id}` is a paddock uuid and is parsed; `{tid}` is the template's OWN id (`txt2img`), which
  // lives inside a JSON column and is never a uuid — parsing it would 422 every legitimate call.
  const paddockId = parsePathId(params.id)
  const body = await readJsonObject(req)
  const saved = await saveTemplate(getDb(), actor, {
    paddockId,
    draft: { ...body, id: params.tid },
  })
  return Response.json(saved)
})

/**
 * 204 rather than the remaining array, so DELETE means the same thing here as on every other
 * resource of this API. `deleteTemplate` filters by id and rewrites the column, so removing an id
 * that is not there is a no-op that still audits — GET the collection to see what is left.
 */
export const DELETE = withAdmin(async ({ actor, params }) => {
  await deleteTemplate(getDb(), actor, { paddockId: parsePathId(params.id), templateId: params.tid })
  return new Response(null, { status: 204 })
})
