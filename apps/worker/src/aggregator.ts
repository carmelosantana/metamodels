import { sql } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { periodBucket, usageRollup, type MeterDim } from '@metamodels/schema'

export interface RollupEvent {
  orgId: string
  keyId: string
  paddockId: string
  dim: MeterDim
  value: number
  at: number
}

type Db = PgDatabase<any, any, any>

/**
 * Upsert a batch of meter events into `usage_rollup`, summing into the
 * hour bucket derived from each event's `at`. The composite UNIQUE index
 * `usage_rollup_key` makes the ON CONFLICT target additive rather than a
 * read-modify-write race. Wrapped in a transaction so a batch is all-or-nothing.
 */
export async function applyEvents(db: Db, events: RollupEvent[]): Promise<void> {
  if (events.length === 0) return
  await db.transaction(async (tx) => {
    for (const e of events) {
      await tx
        .insert(usageRollup)
        .values({
          orgId: e.orgId,
          keyId: e.keyId,
          paddockId: e.paddockId,
          period: periodBucket(e.at),
          dim: e.dim,
          value: e.value,
        })
        .onConflictDoUpdate({
          target: [usageRollup.orgId, usageRollup.keyId, usageRollup.paddockId, usageRollup.period, usageRollup.dim],
          set: { value: sql`${usageRollup.value} + ${e.value}` },
        })
    }
  })
}
