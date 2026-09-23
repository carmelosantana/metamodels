import { afterEach, describe, expect, test, vi } from 'vitest'

// `seal-keys` caches the keyring, so each case needs a fresh module graph.
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

describe('register (Next.js instrumentation — runs once at server boot)', () => {
  test('refuses to boot the Node runtime without UPSTREAM_AUTH_KEY', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs')
    vi.stubEnv('UPSTREAM_AUTH_KEY', '')
    const { register } = await import('./instrumentation')
    await expect(register()).rejects.toThrow(/UPSTREAM_AUTH_KEY/)
  })

  test('refuses a malformed previous key at boot, not at the first credential it meets', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs')
    vi.stubEnv('UPSTREAM_AUTH_PREVIOUS_KEYS', 'not-a-key')
    const { register } = await import('./instrumentation')
    await expect(register()).rejects.toThrow(/UPSTREAM_AUTH_PREVIOUS_KEYS/)
  })

  test('boots with a valid key', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs')
    const { register } = await import('./instrumentation')
    await expect(register()).resolves.toBeUndefined()
  })

  test('does nothing on the edge runtime, which never touches credentials', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge')
    vi.stubEnv('UPSTREAM_AUTH_KEY', '')
    const { register } = await import('./instrumentation')
    await expect(register()).resolves.toBeUndefined()
  })
})
