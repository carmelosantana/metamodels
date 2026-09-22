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
 * org-scoped UPDATE, not an upsert, and throws NotFoundError when it matches no row — so another
 * org's key id can neither be revoked nor distinguished from a nonexistent one.
 *
 * ⚠ This route's idempotence is HTTP-level only. `revokeKey`'s UPDATE has no `status <> 'revoked'`
 * predicate, so a replayed revoke answers 204 again and writes a SECOND `key.revoke` audit row for
 * a call that changed nothing. Pinned by `admin-keys.test.ts`; fixing it means narrowing the
 * service's predicate, which is deliberately not this route's to do.
 */
export const POST = withAdmin(async ({ actor, params }) => {
  await revokeKey(getDb(), actor, parsePathId(params.id))
  return new Response(null, { status: 204 })
})
