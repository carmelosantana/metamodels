import { buildOpenApiDocument } from '../../../../../server/openapi'

/**
 * Deliberately UNAUTHENTICATED, and the only route under `/api/admin/v1` that is: it does not use
 * `withAdmin`. The repo is AGPL and public, so the API's shape is not a secret, and a client needs
 * the schema to bootstrap before it holds a token — gating it would make the document useless to
 * exactly the client that has not authenticated yet.
 *
 * Nothing org-scoped can leak through it: `buildOpenApiDocument` is a pure function of this
 * module's own source, takes no request, and touches no database.
 *
 * `Response.json` sets `content-type: application/json`. Not `application/vnd.oai.openapi+json`:
 * that media type is registered but thinly supported, and a browser or fetch client reaching a
 * bootstrap endpoint should get something it will parse without being asked twice.
 */
export function GET(): Response {
  return Response.json(buildOpenApiDocument(), {
    headers: { 'cache-control': 'public, max-age=300' },
  })
}
