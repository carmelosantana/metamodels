import { afterEach, describe, expect, test, vi } from 'vitest'
import { CAPABILITIES } from '@metamodels/schema'
import { GET } from '../app/.well-known/oauth-protected-resource/api/admin/route'

afterEach(() => { vi.unstubAllEnvs() })

describe('GET /.well-known/oauth-protected-resource/api/admin (M4 §5)', () => {
  test('names the admin API resource, the OP and every capability as a scope', async () => {
    vi.stubEnv('OIDC_ISSUER', 'https://auth.example.test')
    vi.stubEnv('CONSOLE_URL', 'https://console.example.test')
    vi.stubEnv('CONSOLE_CLIENT_SECRET', 'x'.repeat(16))
    const res = GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      resource: 'https://console.example.test/api/admin',
      authorization_servers: ['https://auth.example.test'],
      scopes_supported: [...CAPABILITIES],
      bearer_methods_supported: ['header'],
    })
  })
})
