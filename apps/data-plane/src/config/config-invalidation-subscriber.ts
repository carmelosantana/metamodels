import { CONFIG_INVALIDATE_CHANNEL, decodeConfigInvalidation } from '@metamodels/schema'

export interface Invalidatable {
  invalidateAll(): void
}

/** The minimal ioredis surface this module needs (a duplicated, subscriber-mode connection). */
export interface RedisSubscriber {
  subscribe(channel: string): unknown
  on(event: 'message', listener: (channel: string, message: string) => void): unknown
}

/** Decode a channel payload and flush the store. Malformed payloads are ignored (no throw). */
export function handleInvalidationMessage(payload: string, store: Invalidatable): void {
  try {
    decodeConfigInvalidation(payload) // validates shape; reason is a log hint only
    store.invalidateAll()
  } catch {
    // Ignore malformed messages — never let a bad publish crash the subscriber.
  }
}

/** Subscribe to the config-invalidation channel and flush `store` on every matching message. */
export function subscribeConfigInvalidation(sub: RedisSubscriber, store: Invalidatable): void {
  sub.subscribe(CONFIG_INVALIDATE_CHANNEL)
  sub.on('message', (channel, message) => {
    if (channel === CONFIG_INVALIDATE_CHANNEL) handleInvalidationMessage(message, store)
  })
}
