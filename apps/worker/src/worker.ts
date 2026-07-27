import type { Redis } from 'ioredis'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { applyEvents } from './aggregator.js'
import { ackBatch, ensureGroup, readBatch } from './consumer.js'

export { ensureGroup }

type Db = PgDatabase<any, any, any>

/**
 * One consume→aggregate→ack cycle. Returns the number of events processed.
 * Order matters for at-least-once delivery: the DB upsert commits BEFORE the
 * XACK, so a crash between them redelivers the batch (re-summing it). Exactly-once
 * dedup is deferred (see Plan 4 carry-forward) — acceptable because a crash mid-batch
 * is rare and only over-counts, never under-counts.
 */
export async function processOnce(redis: Redis, db: Db, consumer: string): Promise<number> {
  const { ids, events } = await readBatch(redis, consumer, 100, 1000)
  if (events.length === 0) return 0
  await applyEvents(db, events)
  await ackBatch(redis, ids)
  return events.length
}
