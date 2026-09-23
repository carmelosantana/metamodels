import { withAdmin } from '../../../../../../../server/admin-route'
import { getDb } from '../../../../../../../server/db'
import { readJsonObject } from '../../../../../../../server/json-body'
import { listTemplates, saveTemplate } from '../../../../../../../server/templates-service'
import { parsePathId } from '../../../../../../../server/path-id'

/**
 * Templates live inside the paddock's fence `constraint_json`, not in a table of their own, so this
 * collection is a projection of one column. A non-comfyui paddock has no such collection and 404s
 * (`currentTemplates` rejects any other breed) — the same status a paddock in another org gets,
 * which is the point: neither tells a caller anything about rows they may not see.
 */
export const GET = withAdmin(async ({ actor, params }) =>
  Response.json(await listTemplates(getDb(), actor, parsePathId(params.id))))

/**
 * ⚠ The 201 body is the WHOLE template array, not the created template. `saveTemplate` returns the
 * collection because that is what it writes — one `constraint_json` column — and reshaping it here
 * to look like a conventional create would mean the route inventing a representation the service
 * never produced, and a client losing the only cheap view of what the paddock now allows.
 *
 * No `Location` header for the same reason the body is a collection: the draft's `id` is the
 * client's own, echoed back inside the array, so a header would restate what the caller already
 * sent while implying a resource this response did not describe.
 *
 * No route-level tenancy pre-read, and this is NOT the `get*`-before-`PUT` guard being dropped as
 * an optimization: `saveTemplate` opens its transaction with `currentTemplates` →
 * `paddockBreedInOrg`, so the org check is ATOMIC with the fence upsert that follows it. A read out
 * here would be strictly weaker — outside that transaction, racing it — and the upsert is exactly
 * the shape (`onConflictDoUpdate` keyed on paddock_id, values carrying `actor.orgId`) that would
 * otherwise create a row under this actor's org from another org's paddock id.
 */
export const POST = withAdmin(async ({ actor, req, params }) => {
  // Before the body, not after: a path that names no resource makes the body moot (`path-id.ts`).
  const paddockId = parsePathId(params.id)
  const draft = await readJsonObject(req)
  const saved = await saveTemplate(getDb(), actor, { paddockId, draft })
  return Response.json(saved, { status: 201 })
}, { invalidates: 'template.save' })
