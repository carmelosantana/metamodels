import { describe, expect, test, vi } from 'vitest'
import { CONFIG_INVALIDATE_CHANNEL, encodeConfigInvalidation } from '@metamodels/schema'
import {
  handleInvalidationMessage, subscribeConfigInvalidation, type RedisSubscriber,
} from '../src/config/config-invalidation-subscriber.js'

function counter() {
  return { n: 0, invalidateAll() { this.n++ } }
}

describe('config invalidation subscriber', () => {
  test('handleInvalidationMessage flushes on a valid payload', () => {
    const store = counter()
    handleInvalidationMessage(encodeConfigInvalidation('flock.save', 1), store)
    expect(store.n).toBe(1)
  })

  test('handleInvalidationMessage ignores a malformed payload (no throw, no flush)', () => {
    const store = counter()
    expect(() => handleInvalidationMessage('not json', store)).not.toThrow()
    expect(store.n).toBe(0)
  })

  test('subscribeConfigInvalidation subscribes to the channel and flushes on a matching message', () => {
    const store = counter()
    let handler: ((channel: string, message: string) => void) | undefined
    const sub: RedisSubscriber = {
      subscribe: vi.fn(),
      on: (_event, listener) => { handler = listener },
    }
    subscribeConfigInvalidation(sub, store)
    expect(sub.subscribe).toHaveBeenCalledWith(CONFIG_INVALIDATE_CHANNEL)

    handler!(CONFIG_INVALIDATE_CHANNEL, encodeConfigInvalidation('key.revoke', 2))
    expect(store.n).toBe(1)

    handler!('some:other:channel', encodeConfigInvalidation('x', 3)) // wrong channel ignored
    expect(store.n).toBe(1)
  })
})
