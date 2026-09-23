import { withAdmin } from '../../../../../server/admin-route'
import { getDb } from '../../../../../server/db'
import { readJsonObject } from '../../../../../server/json-body'
import { listPaddocks, savePaddock } from '../../../../../server/paddocks-service'
import { encodeCursor, linkHeader, parsePageOpts } from '../../../../../server/page'
import { problem } from '../../../../../server/problem'

export const GET = withAdmin(async ({ actor, req }) => {
  const url = new URL(req.url)
  const opts = parsePageOpts(url)
  const rows = await listPaddocks(getDb(), actor, opts)
  // A full page means "there may be more", not "there is more": the service returns at most
  // `limit` rows and no has-more signal, so a traversal that ends on an exact multiple of the
  // limit yields one trailing empty page. Known and accepted — the alternative is asking every
  // collection handler for `limit + 1` rows and discarding one, to save a single cheap request.
  const next = rows.length === opts.limit ? encodeCursor(rows[rows.length - 1].id) : null
  return Response.json(rows, { headers: linkHeader(url, next) })
})

export const POST = withAdmin(async ({ actor, req }) => {
  const body = await readJsonObject(req)
  // POST creates. An `id` in the body would turn this into an update, which is what PUT is for.
  if (body.id !== undefined) {
    return problem(422, 'Unprocessable Content', 'POST creates; use PUT /paddocks/{id} to replace')
  }
  const created = await savePaddock(getDb(), actor, body)
  // Derived from the request, never a hand-written literal: a copied literal can name a resource
  // this module does not serve, and the test that pins it copies wrong in exactly the same way.
  return Response.json(created, {
    status: 201,
    headers: { location: `${new URL(req.url).pathname}/${created.id}` },
  })
}, { invalidates: 'paddock.save' })
