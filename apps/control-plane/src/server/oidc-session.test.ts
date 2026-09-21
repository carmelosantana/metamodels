import { beforeEach, describe, expect, test, vi } from 'vitest'
import { sealJson } from '../auth/session'

const SECRET = 's'.repeat(32)

// A fake cookie jar: only the calls takeTransactionCookie makes.
const jar = vi.hoisted(() => ({
  value: undefined as string | undefined,
  get: vi.fn(),
  delete: vi.fn(),
}))
vi.mock('next/headers', () => ({ cookies: async () => jar }))
vi.mock('./current-user', () => ({ sessionSecret: () => SECRET }))

const { takeTransactionCookie, TX_COOKIE } = await import('./oidc-session')

const DELETE = { name: 'mm_oidc_tx', path: '/auth/callback' }

beforeEach(() => {
  jar.value = undefined
  jar.get.mockReset().mockImplementation((name: string) =>
    name === TX_COOKIE && jar.value !== undefined ? { name, value: jar.value } : undefined)
  jar.delete.mockReset()
})

// The delete-before-validate order IS the replay protection: every attempt, good or bad, consumes
// the transaction, so a callback URL can never be completed twice.
describe('takeTransactionCookie — one attempt per sign-in', () => {
  test('an absent cookie still deletes the transaction', async () => {
    expect(await takeTransactionCookie()).toBeNull()
    expect(jar.delete).toHaveBeenCalledWith(DELETE)
  })

  test('a garbage cookie is deleted and yields nothing', async () => {
    jar.value = 'not-a-sealed-value'
    expect(await takeTransactionCookie()).toBeNull()
    expect(jar.delete).toHaveBeenCalledWith(DELETE)
  })

  test('a valid cookie is deleted as it is read', async () => {
    const tx = { state: 'st', nonce: 'n', codeVerifier: 'v'.repeat(43) }
    jar.value = sealJson({ ...tx }, SECRET, 60_000, Date.now())
    expect(await takeTransactionCookie()).toEqual(tx)
    expect(jar.delete).toHaveBeenCalledWith(DELETE)
  })
})
