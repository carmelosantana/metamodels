import { parseMcpResource } from '@metamodels/schema'
import { loadDataPlaneUrl } from '../../../../../../server/data-plane-url'
import { getDb } from '../../../../../../server/db'
import { withConsentAssertion } from '../../../../../../server/internal-route'
import { preflightOauthKey } from '../../../../../../server/keys-service'

/** Read-only: may this user approve this client for this paddock? Asked before the consent screen renders. */
export const GET = withConsentAssertion(async ({ claims, actor }) =>
  Response.json(await preflightOauthKey(getDb(), actor, parseMcpResource(loadDataPlaneUrl(), claims.resource))),
{ requireGrant: false })
