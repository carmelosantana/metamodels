import { and, eq, gt, isNull, or, type SQL } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { apiKey, fence, flock, keyPaddock, paddock } from '@metamodels/schema'
import { openSealed, UnsealError, type SealKeyring, type UnsealReason } from '@metamodels/schema/sealed'
import type { KeyOverrides, RateLimit, ResolvedKey, ResolvedPaddock } from './types.js'

export interface ConfigStore {
  /** A consumer `mm_live_` key by the hash of its plaintext: `kind='live'`, active and unexpired, else null. */
  resolveKeyByHash(hash: string): Promise<ResolvedKey | null>
  /** An oauth key by id, as an MCP access token's `mm_kid` names it: `kind='oauth'`, active and unexpired, else null (M4 §4.2). */
  resolveKeyById(id: string): Promise<ResolvedKey | null>
  getPaddockBySlug(slug: string): Promise<ResolvedPaddock | null>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A key the data plane may honour right now: active, and not past its `expires_at` (Kanboard #4558,
 * follow-up ruling F9). In the lookup itself, so an unknown, revoked and expired key all cost the same
 * one query and resolve to the same null; only a usable key goes on to load its paddocks. The callers
 * still check `expiresAt`: `CachingConfigStore` can serve a key for up to its TTL after it expires.
 */
function usable(now: Date): SQL {
  return and(eq(apiKey.status, 'active'), or(isNull(apiKey.expiresAt), gt(apiKey.expiresAt, now)))!
}

// Accepts any Drizzle Postgres database (postgres-js in prod, pglite in tests).
type Db = PgDatabase<any, any, any>

export class DrizzleConfigStore implements ConfigStore {
  constructor(private readonly db: Db, private readonly ring: SealKeyring) {}

  async resolveKeyByHash(hash: string): Promise<ResolvedKey | null> {
    const rows = await this.db.select().from(apiKey)
      .where(and(eq(apiKey.hash, hash), eq(apiKey.kind, 'live'), usable(new Date()))).limit(1)
    return this.resolve(rows[0])
  }

  async resolveKeyById(id: string): Promise<ResolvedKey | null> {
    // `mm_kid` comes from a verified token, but a malformed id must still be a miss, not a driver error.
    if (!UUID.test(id)) return null
    const rows = await this.db.select().from(apiKey)
      .where(and(eq(apiKey.id, id), eq(apiKey.kind, 'oauth'), usable(new Date()))).limit(1)
    return this.resolve(rows[0])
  }

  private async resolve(key: typeof apiKey.$inferSelect | undefined): Promise<ResolvedKey | null> {
    if (!key) return null

    const links = await this.db
      .select({ slug: paddock.slug })
      .from(keyPaddock)
      .innerJoin(paddock, eq(keyPaddock.paddockId, paddock.id))
      .where(eq(keyPaddock.keyId, key.id))

    return {
      keyId: key.id,
      orgId: key.orgId,
      status: key.status,
      expiresAt: key.expiresAt ?? null,
      paddockSlugs: links.map((l) => l.slug),
      overrides: (key.overrides as KeyOverrides | null) ?? null,
      ...(key.oauthClientId ? { oauthClientId: key.oauthClientId } : {}),
    }
  }

  async getPaddockBySlug(slug: string): Promise<ResolvedPaddock | null> {
    const rows = await this.db
      .select({ paddock, flock, fence })
      .from(paddock)
      .innerJoin(flock, eq(paddock.flockId, flock.id))
      .leftJoin(fence, eq(fence.paddockId, paddock.id))
      .where(eq(paddock.slug, slug))
      .limit(1)
    const row = rows[0]
    if (!row) return null

    let upstreamAuth: string | null = null
    let upstreamAuthError: UnsealReason | undefined
    if (row.flock.upstreamAuthEnc !== null) {
      try {
        // Bound to this row: an envelope copied here from another flock or org will not open.
        upstreamAuth = openSealed(row.flock.upstreamAuthEnc, this.ring, { orgId: row.flock.orgId, flockId: row.flock.id })
      } catch (e) {
        if (!(e instanceof UnsealError)) throw e
        // Resolved, not thrown: the caller must still run the key and scope gates first, so that an
        // unauthenticated request cannot tell this paddock apart from any other.
        upstreamAuthError = e.reason
        // eslint-disable-next-line no-console
        console.error(`[config] flock ${row.flock.id}: ${e.message}`)
      }
    }

    return {
      paddockId: row.paddock.id,
      orgId: row.paddock.orgId,
      slug: row.paddock.slug,
      name: row.paddock.name,
      status: row.paddock.status,
      breedId: row.flock.breed,
      flock: {
        baseUrl: row.flock.baseUrl,
        upstreamAuth,
        tlsTrust: row.flock.tlsTrust,
      },
      fence: {
        constraintJson: row.fence?.constraintJson ?? {},
        rateLimit: (row.fence?.rateLimit as RateLimit | null) ?? null,
        quota: row.fence?.quota ?? null,
      },
      ...(upstreamAuthError ? { upstreamAuthError } : {}),
    }
  }
}
