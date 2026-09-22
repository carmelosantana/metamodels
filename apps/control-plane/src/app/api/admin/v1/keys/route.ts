import { withAdmin } from '../../../../../server/admin-route'
import { getDb } from '../../../../../server/db'
import { readJsonObject } from '../../../../../server/json-body'
import { createKey, listKeys } from '../../../../../server/keys-service'
import { encodeCursor, linkHeader, parsePageOpts } from '../../../../../server/page'

export const GET = withAdmin(async ({ actor, req }) => {
  const url = new URL(req.url)
  const opts = parsePageOpts(url)
  const rows = await listKeys(getDb(), actor, opts)
  // A full page means "there may be more", not "there is more": the service returns at most
  // `limit` rows and no has-more signal, so a traversal that ends on an exact multiple of the
  // limit yields one trailing empty page. Known and accepted — the alternative is asking every
  // collection handler for `limit + 1` rows and discarding one, to save a single cheap request.
  const next = rows.length === opts.limit ? encodeCursor(rows[rows.length - 1].id) : null
  return Response.json(rows, { headers: linkHeader(url, next) })
})

/**
 * 201 carrying `plaintext`, which is the ONLY time the secret exists outside the caller's hands:
 * `createKey` stores a sha256 and returns the plaintext once, and `listKeys` never selects a column
 * that could reconstruct it. A client that drops this response has lost the key, not mislaid it.
 *
 * No `Location` header, deliberately, and not an oversight of the flocks/paddocks pattern this
 * otherwise copies: `/keys/{id}` serves NO representation — its only method is the 405 refusal
 * (spec §2.1). A `Location` pointing at a URI where every method is refused would send a client to
 * a dead end, which is worse than no header at all. There is also no `id`-in-the-body 422 guard
 * here for the same reason: that guard says "use PUT /{id} instead", and no such route exists. The
 * id is server-generated and `createKeyInput` strips unknown fields, so a supplied one is inert.
 */
export const POST = withAdmin(async ({ actor, req }) => {
  const body = await readJsonObject(req)
  const created = await createKey(getDb(), actor, body)
  return Response.json(created, { status: 201 })
})
