import { adminApiResource, CAPABILITIES, protectedResourceMetadata } from '@metamodels/schema'
import { loadOidcClientConfig } from '../../../../../auth/oidc-client'

// Read per request: the image is built once, with no deployment's values present.
export const dynamic = 'force-dynamic'

/** RFC 9728 metadata for the admin API (M4 §5). Public: it names the resource and its OP, nothing else. */
export function GET(): Response {
  const { issuer, consoleUrl } = loadOidcClientConfig()
  return Response.json(protectedResourceMetadata(adminApiResource(consoleUrl), issuer, CAPABILITIES))
}
