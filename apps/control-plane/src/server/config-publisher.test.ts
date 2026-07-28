import { describe, expect, test, vi } from 'vitest'
import { CONFIG_INVALIDATE_CHANNEL, decodeConfigInvalidation } from '@metamodels/schema'
import { publishConfigInvalidation, type ConfigPublisher } from './config-publisher'

describe('publishConfigInvalidation', () => {
  test('publishes a decodable invalidation to the shared channel', async () => {
    const publish = vi.fn().mockResolvedValue(1)
    const fake: ConfigPublisher = { publish }
    await publishConfigInvalidation('flock.save', fake)
    expect(publish).toHaveBeenCalledTimes(1)
    const [channel, message] = publish.mock.calls[0]
    expect(channel).toBe(CONFIG_INVALIDATE_CHANNEL)
    const decoded = decodeConfigInvalidation(message as string)
    expect(decoded.reason).toBe('flock.save')
    expect(typeof decoded.at).toBe('number')
  })

  test('a null publisher (no REDIS_URL) is a no-op and does not throw', async () => {
    await expect(publishConfigInvalidation('x', null)).resolves.toBeUndefined()
  })

  test('swallows publisher errors (never breaks the caller)', async () => {
    const fake: ConfigPublisher = { publish: vi.fn().mockRejectedValue(new Error('boom')) }
    await expect(publishConfigInvalidation('x', fake)).resolves.toBeUndefined()
  })
})
