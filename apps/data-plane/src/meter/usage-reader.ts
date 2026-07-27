import { and, eq, like, sql } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { periodPrefix, usageRollup, type QuotaWindow } from '@metamodels/schema'

export interface UsageReader {
  /** Sum of a dimension's rollup value for the (key,paddock) over the quota window containing `atMs`. */
  periodUsage(keyId: string, paddockId: string, dim: string, win: QuotaWindow, atMs: number): Promise<number>
}

type Db = PgDatabase<any, any, any>

export class DrizzleUsageReader implements UsageReader {
  constructor(private readonly db: Db) {}

  async periodUsage(keyId: string, paddockId: string, dim: string, win: QuotaWindow, atMs: number): Promise<number> {
    const prefix = periodPrefix(win, atMs)
    const rows = await this.db
      .select({ total: sql<number>`coalesce(sum(${usageRollup.value}), 0)` })
      .from(usageRollup)
      .where(
        and(
          eq(usageRollup.keyId, keyId),
          eq(usageRollup.paddockId, paddockId),
          eq(usageRollup.dim, dim),
          like(usageRollup.period, `${prefix}%`),
        ),
      )
    return Number(rows[0]?.total ?? 0)
  }
}
