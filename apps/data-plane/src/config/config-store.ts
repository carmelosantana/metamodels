import { eq } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { apiKey, fence, flock, keyPaddock, paddock } from '@metamodels/schema'
import { openSealed, UnsealError, type SealKeyring, type UnsealReason } from '@metamodels/schema/sealed'
import type { KeyOverrides, RateLimit, ResolvedKey, ResolvedPaddock } from './types.js'

export interface ConfigStore {
  resolveKeyByHash(hash: string): Promise<ResolvedKey | null>
  getPaddockBySlug(slug: string): Promise<ResolvedPaddock | null>
}

// Accepts any Drizzle Postgres database (postgres-js in prod, pglite in tests).
type Db = PgDatabase<any, any, any>

export class DrizzleConfigStore implements ConfigStore {
  constructor(private readonly db: Db, private readonly ring: SealKeyring) {}

  async resolveKeyByHash(hash: string): Promise<ResolvedKey | null> {
    const rows = await this.db.select().from(apiKey).where(eq(apiKey.hash, hash)).limit(1)
    const key = rows[0]
    if (!key || key.status !== 'active') return null

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
        upstreamAuth = openSealed(row.flock.upstreamAuthEnc, this.ring)
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
