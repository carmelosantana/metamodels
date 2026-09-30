import { and, eq } from 'drizzle-orm'
import { apiKey, keyPaddock, paddock } from '@metamodels/schema'
import type { Db } from './db.js'

/**
 * The OP's only reads of control-plane data besides `user` (M4 D2, D7). Read-only by construction:
 * nothing in this service writes these tables; `keys-service` in the control plane is their writer.
 */
export interface PaddockSummary {
  id: string
  orgId: string
  slug: string
  name: string
  status: string
}

export async function findPaddock(db: Db, slug: string): Promise<PaddockSummary | null> {
  const rows = await db
    .select({ id: paddock.id, orgId: paddock.orgId, slug: paddock.slug, name: paddock.name, status: paddock.status })
    .from(paddock)
    .where(eq(paddock.slug, slug))
    .limit(1)
  return rows[0] ?? null
}

/**
 * The active oauth key bound to `grantId` for the paddock `slug`, or null. One grant can back keys for
 * several paddocks — oidc-provider reuses a browser session's grant for a client across resources — so
 * the paddock is part of the lookup, not just the grant.
 */
export async function activeOauthKeyForGrant(db: Db, grantId: string, slug: string): Promise<string | null> {
  const rows = await db
    .select({ id: apiKey.id })
    .from(apiKey)
    .innerJoin(keyPaddock, eq(keyPaddock.keyId, apiKey.id))
    .innerJoin(paddock, eq(paddock.id, keyPaddock.paddockId))
    .where(and(eq(apiKey.grantId, grantId), eq(apiKey.kind, 'oauth'), eq(apiKey.status, 'active'), eq(paddock.slug, slug)))
    .limit(1)
  return rows[0]?.id ?? null
}
