import { describe, expect, test, vi } from 'vitest'
import { LemonSqueezyClient, type LsFetch } from './ls-client'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('LemonSqueezyClient', () => {
  test('activate posts to /v1/licenses/activate and normalizes the response', async () => {
    const fetchImpl = vi.fn<LsFetch>().mockResolvedValue(jsonResponse({
      activated: true,
      instance: { id: 'inst_123', name: 'my-box' },
      license_key: { status: 'active' },
      meta: { variant_name: 'Team 5' },
    }))
    const client = new LemonSqueezyClient({ fetchImpl })
    const r = await client.activate('LICENSE-KEY', 'my-box')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.lemonsqueezy.com/v1/licenses/activate')
    expect(init.method).toBe('POST')
    expect(String(init.body)).toContain('LICENSE-KEY')
    expect(String(init.body)).toContain('my-box')
    expect(r).toEqual({ valid: true, status: 'active', instanceId: 'inst_123', variantName: 'Team 5' })
  })

  test('validate normalizes valid:false without throwing', async () => {
    const fetchImpl = vi.fn<LsFetch>().mockResolvedValue(jsonResponse({
      valid: false, license_key: { status: 'expired' }, instance: null, meta: { variant_name: 'Team 5' },
    }))
    const client = new LemonSqueezyClient({ fetchImpl })
    const r = await client.validate('LICENSE-KEY', 'inst_123')
    expect(r).toEqual({ valid: false, status: 'expired', instanceId: null, variantName: 'Team 5' })
  })

  test('deactivate returns the deactivated flag', async () => {
    const fetchImpl = vi.fn<LsFetch>().mockResolvedValue(jsonResponse({ deactivated: true }))
    const client = new LemonSqueezyClient({ fetchImpl })
    expect(await client.deactivate('LICENSE-KEY', 'inst_123')).toEqual({ deactivated: true })
  })

  test('a transport error propagates (so grace logic can catch it)', async () => {
    const fetchImpl = vi.fn<LsFetch>().mockRejectedValue(new Error('ECONNREFUSED'))
    const client = new LemonSqueezyClient({ fetchImpl })
    await expect(client.validate('K', 'inst_123')).rejects.toThrow('ECONNREFUSED')
  })
})
