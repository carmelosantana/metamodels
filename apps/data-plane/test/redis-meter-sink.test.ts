import { beforeEach, describe, expect, test } from 'vitest'
import RedisMock from 'ioredis-mock'
import { decodeMeterEvent, METER_STREAM_KEY } from '@metamodels/schema'
import { RedisMeterSink } from '../src/meter/redis-meter-sink.js'
import type { MeterEventRecord } from '../src/meter/meter-sink.js'

function rec(dim: MeterEventRecord['dim'], value: number): MeterEventRecord {
  return { orgId: 'o', keyId: 'k', paddockId: 'p', breedId: 'ollama', dim, value, at: 1000 }
}

// ioredis-mock shares one in-memory store across all `new RedisMock()` instances
// in the process, so flush it before each test to keep them isolated.
let redis: InstanceType<typeof RedisMock>
beforeEach(async () => {
  redis = new RedisMock()
  await redis.flushall()
})

describe('RedisMeterSink', () => {
  test('emit XADDs one stream entry per event', async () => {
    const sink = new RedisMeterSink(redis as any)
    await sink.emit([rec('tokens_in', 3), rec('tokens_out', 5)])
    expect(await redis.xlen(METER_STREAM_KEY)).toBe(2)
  })

  test('the XADDed entries decode back to the original events', async () => {
    const sink = new RedisMeterSink(redis as any)
    await sink.emit([rec('tokens_out', 5)])
    const entries = await redis.xrange(METER_STREAM_KEY, '-', '+')
    // entries: [ [id, [field, value, ...]], ... ]
    const decoded = decodeMeterEvent(entries[0][1])
    expect(decoded).toMatchObject({ dim: 'tokens_out', value: 5, keyId: 'k' })
  })

  test('emit of an empty array is a no-op', async () => {
    const sink = new RedisMeterSink(redis as any)
    await sink.emit([])
    expect(await redis.xlen(METER_STREAM_KEY)).toBe(0)
  })
})
