import { parseMcpResource } from '@metamodels/schema'
import { publishConfigInvalidation } from '../../../../../server/config-publisher'
import { loadDataPlaneUrl } from '../../../../../server/data-plane-url'
import { getDb } from '../../../../../server/db'
import { NotFoundError } from '../../../../../server/flocks-service'
import { withConsentAssertion } from '../../../../../server/internal-route'
import { mintOauthKey } from '../../../../../server/keys-service'

/**
 * The consent-time mint (M4 D7), called by the OP on Approve over the compose network. The OP saves
 * its grant only after this answers 200, so no grant ever exists without a key. 403 (no
 * `resource.write`) and 404 (unknown, disabled or foreign paddock) come from `mintOauthKey` through
 * `problemForError`. The invalidation is published here because `keys-service` never publishes; every
 * surface that calls it does (the console's actions, `withAdmin`).
 */
export const POST = withConsentAssertion(async ({ claims, actor }) => {
  const slug = parseMcpResource(loadDataPlaneUrl(), claims.resource)
  if (slug === null) throw new NotFoundError('paddock')
  const minted = await mintOauthKey(getDb(), actor, {
    clientId: claims.clientId,
    clientName: claims.clientName,
    paddockSlug: slug,
    grantId: claims.grantId!,
  })
  await publishConfigInvalidation(minted.outcome === 'created' ? 'key.create' : 'key.rebind')
  return Response.json({ key_id: minted.keyId })
}, { requireGrant: true })
