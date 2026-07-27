import type { Redis } from 'ioredis'
import { encodeMeterEvent, METER_STREAM_KEY } from '@metamodels/schema'
import type { MeterEventRecord, MeterSink } from './meter-sink.js'

/**
 * Durable {@link MeterSink} that XADDs each meter event to a Redis stream on the
 * hot path (fast, fire-and-forget from the request's perspective; the caller
 * already runs this best-effort + drained). The `apps/worker` consumer group
 * aggregates the stream into `usage_rollup`. `MAXLEN ~` caps unbounded growth.
 */
export class RedisMeterSink implements MeterSink {
  constructor(
    private readonly redis: Redis,
    private readonly maxLen = 100_000,
  ) {}

  async emit(events: MeterEventRecord[]): Promise<void> {
    if (events.length === 0) return
    const pipe = this.redis.pipeline()
    for (const e of events) {
      const { data } = encodeMeterEvent(e)
      pipe.xadd(METER_STREAM_KEY, 'MAXLEN', '~', String(this.maxLen), '*', 'data', data)
    }
    await pipe.exec()
  }
}
