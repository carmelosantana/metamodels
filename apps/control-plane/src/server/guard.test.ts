import { describe, expect, test, vi, beforeEach } from 'vitest'
import type { Actor } from '../auth/authorize'

const actorRef: { current: Actor | null } = { current: null }
const notFound = vi.fn(() => { throw new Error('NEXT_NOT_FOUND') })
const redirect = vi.fn((to: string) => { throw new Error(`NEXT_REDIRECT:${to}`) })

vi.mock('next/navigation', () => ({ notFound: () => notFound(), redirect: (to: string) => redirect(to) }))
vi.mock('./current-user', () => ({ getCurrentActor: async () => actorRef.current }))

const { requireCapabilityOr403 } = await import('./guard')

beforeEach(() => { actorRef.current = null; notFound.mockClear(); redirect.mockClear() })

describe('requireCapabilityOr403', () => {
  test('redirects to /login when unauthenticated', async () => {
    await expect(requireCapabilityOr403('user.manage')).rejects.toThrow('NEXT_REDIRECT:/login')
  })

  test('calls notFound() when the actor lacks the capability', async () => {
    actorRef.current = { id: 'u', orgId: 'o', email: 'm@x.io', role: 'member' }
    await expect(requireCapabilityOr403('user.manage')).rejects.toThrow('NEXT_NOT_FOUND')
    expect(notFound).toHaveBeenCalledOnce()
  })

  test('returns the actor when authorized', async () => {
    actorRef.current = { id: 'u', orgId: 'o', email: 'a@x.io', role: 'admin' }
    const actor = await requireCapabilityOr403('user.manage')
    expect(actor.email).toBe('a@x.io')
    expect(notFound).not.toHaveBeenCalled()
  })
})
