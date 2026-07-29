import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import Redis from 'ioredis'
import { CachingConfigStore } from '../src/config/caching-config-store.js'
import { subscribeConfigInvalidation } from '../src/config/config-invalidation-subscriber.js'
import { publishConfigInvalidation } from '../../control-plane/src/server/config-publisher'
import type { ConfigStore } from '../src/config/config-store.js'

const REDIS_URL = process.env.REDIS_TEST_URL

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Real cross-connection pub/sub: publish on one ioredis client, receive on a duplicated
// subscriber connection, and confirm the CachingConfigStore flushed. ioredis-mock cannot deliver
// across connections, so this runs only against a real Redis (REDIS_TEST_URL) and skips otherwise.
describe.skipIf(!REDIS_URL)('config invalidation pub/sub (real Redis)', () => {
  let pub: Redis
  let sub: Redis
  beforeAll(() => {
    pub = new Redis(REDIS_URL!, { maxRetriesPerRequest: null })
    sub = pub.duplicate()
  })
  afterAll(async () => {
    await sub.quit()
    await pub.quit()
  })

  test('a published invalidation flushes the caching store on the subscriber side', async () => {
    // A fake inner store that counts how many times the cache had to hit it.
    let innerCalls = 0
    const inner: ConfigStore = {
      async resolveKeyByHash() {
        innerCalls++
        return null
      },
      async getPaddockBySlug() {
        return null
      },
    }
    const store = new CachingConfigStore(inner, { ttlMs: 60_000 })

    // Prime the cache: first read hits inner (count 1); a second read is a cache hit (still 1).
    await store.resolveKeyByHash('h')
    await store.resolveKeyByHash('h')
    expect(innerCalls).toBe(1)

    // Wire the real subscriber, then wait for the SUBSCRIBE round-trip to land before publishing.
    subscribeConfigInvalidation(sub, store)
    await sleep(150)

    // Publish on the OTHER connection. This is the seam under test.
    await publishConfigInvalidation('test', pub)

    // Delivery is async; poll — after the flush the next read must hit inner again (count → 2).
    let flushed = false
    for (let i = 0; i < 100; i++) {
      await store.resolveKeyByHash('h')
      if (innerCalls >= 2) {
        flushed = true
        break
      }
      await sleep(20)
    }
    expect(flushed).toBe(true)
  })
})
