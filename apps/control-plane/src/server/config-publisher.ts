import { CONFIG_INVALIDATE_CHANNEL, encodeConfigInvalidation } from '@metamodels/schema'

/** The minimal publish surface (satisfied by an ioredis client). */
export interface ConfigPublisher {
  publish(channel: string, message: string): Promise<unknown>
}

// undefined = not yet initialised; null = disabled (no REDIS_URL); object = live client.
let singleton: ConfigPublisher | null | undefined

/** Lazily build (once) the ioredis publisher from REDIS_URL, or null when Redis is unconfigured. */
async function defaultPublisher(): Promise<ConfigPublisher | null> {
  if (singleton !== undefined) return singleton
  const url = process.env.REDIS_URL
  if (!url) {
    singleton = null
    return null
  }
  const { default: Redis } = await import('ioredis')
  const client = new Redis(url)
  client.on('error', (e) => {
    // eslint-disable-next-line no-console
    console.error('[config-publisher] redis connection error:', e)
  })
  singleton = client
  return singleton
}

/**
 * Publish a config-invalidation signal so the data-plane flushes its config cache.
 * Post-commit, best-effort: never throws (a failed publish is logged; the TTL backstops it).
 * Pass `null` to force a no-op, or a fake to inject (tests); omit to use the REDIS_URL singleton.
 */
export async function publishConfigInvalidation(
  reason: string, publisher?: ConfigPublisher | null,
): Promise<void> {
  const p = publisher !== undefined ? publisher : await defaultPublisher()
  if (!p) return
  try {
    await p.publish(CONFIG_INVALIDATE_CHANNEL, encodeConfigInvalidation(reason, Date.now()))
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[config-publisher] invalidation publish failed:', e)
  }
}
