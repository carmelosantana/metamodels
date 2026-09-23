import { withAdmin } from '../../../../../../../server/admin-route'
import { getDb } from '../../../../../../../server/db'
import { revokeKey } from '../../../../../../../server/keys-service'
import { parsePathId } from '../../../../../../../server/path-id'

/**
 * The only way to retire a key over this API — `DELETE /keys/{id}` refuses precisely so that this
 * route is the one that acts (see `../route.ts`). `revokeKey` flips `status` to 'revoked' and
 * writes a `key.revoke` audit row inside one transaction; the row, and the usage history hanging
 * off it, survive.
 *
 * 204 with no body: the key's post-revocation representation is not retrievable (there is no
 * `GET /keys/{id}`), so there is nothing truthful to return. Re-list the collection to see status.
 *
 * No `getKey` guard precedes it, and unlike the item PUTs that is correct here: `revokeKey` is an
 * org-scoped UPDATE, not an upsert, so another org's key id can never be revoked. Its UPDATE
 * matches no row in three cases, and only TWO of them throw NotFoundError — a key that does not
 * exist, and one belonging to another org, which stay indistinguishable on purpose. The third, an
 * already-revoked key in this org, returns quietly; see below.
 *
 * Idempotent in both halves, and not merely at the HTTP level: `revokeKey`'s UPDATE test-and-sets
 * on `status = 'active'`, so a replayed revoke answers 204 again and writes NO second `key.revoke`
 * audit row for a call that changed nothing. `admin-keys.test.ts` asserts exactly that — one audit
 * row after two revokes — so a service change that reintroduced the duplicate would fail there.
 */
export const POST = withAdmin(async ({ actor, params }) => {
  await revokeKey(getDb(), actor, parsePathId(params.id))
  return new Response(null, { status: 204 })
})
