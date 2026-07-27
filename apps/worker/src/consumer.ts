import type { Redis } from 'ioredis'
import { decodeMeterEvent, METER_GROUP, METER_STREAM_KEY } from '@metamodels/schema'
import type { RollupEvent } from './aggregator.js'

/** Create the consumer group (idempotent). `MKSTREAM` creates the stream if absent. */
export async function ensureGroup(redis: Redis): Promise<void> {
  try {
    await redis.xgroup('CREATE', METER_STREAM_KEY, METER_GROUP, '$', 'MKSTREAM')
  } catch (e) {
    if (!String((e as Error).message).includes('BUSYGROUP')) throw e
  }
}

/** Read up to `count` new entries for this consumer. Returns decoded events + their stream ids. */
export async function readBatch(
  redis: Redis,
  consumer: string,
  count: number,
  blockMs: number,
): Promise<{ ids: string[]; events: RollupEvent[] }> {
  const res = (await redis.xreadgroup(
    'GROUP', METER_GROUP, consumer,
    'COUNT', String(count),
    'BLOCK', String(blockMs),
    'STREAMS', METER_STREAM_KEY, '>',
  )) as [string, [string, string[]][]][] | null

  const ids: string[] = []
  const events: RollupEvent[] = []
  if (!res) return { ids, events }
  for (const [, entries] of res) {
    for (const [id, fields] of entries) {
      ids.push(id)
      const e = decodeMeterEvent(fields)
      events.push({ orgId: e.orgId, keyId: e.keyId, paddockId: e.paddockId, dim: e.dim as RollupEvent['dim'], value: e.value, at: e.at })
    }
  }
  return { ids, events }
}

/** Acknowledge processed entries so they are not redelivered. */
export async function ackBatch(redis: Redis, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await redis.xack(METER_STREAM_KEY, METER_GROUP, ...ids)
}
