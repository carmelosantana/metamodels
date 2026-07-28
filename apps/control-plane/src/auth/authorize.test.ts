import { describe, expect, test } from 'vitest'
import { authorize, requireCapability, ForbiddenError, isRole, type Actor } from './authorize'

const actor = (role: Actor['role']): Actor => ({ id: 'u1', orgId: 'o1', email: 'a@b.c', role })

describe('authorize', () => {
  test('admin can do everything', () => {
    for (const cap of ['read', 'resource.write', 'user.manage', 'license.manage'] as const) {
      expect(authorize({ role: 'admin' }, cap)).toBe(true)
    }
  })

  test('member has full resource CRUD but no user/license management', () => {
    expect(authorize({ role: 'member' }, 'read')).toBe(true)
    expect(authorize({ role: 'member' }, 'resource.write')).toBe(true)
    expect(authorize({ role: 'member' }, 'user.manage')).toBe(false)
    expect(authorize({ role: 'member' }, 'license.manage')).toBe(false)
  })

  test('viewer is read-only', () => {
    expect(authorize({ role: 'viewer' }, 'read')).toBe(true)
    expect(authorize({ role: 'viewer' }, 'resource.write')).toBe(false)
    expect(authorize({ role: 'viewer' }, 'user.manage')).toBe(false)
  })

  test('requireCapability throws ForbiddenError with the capability attached', () => {
    expect(() => requireCapability(actor('viewer'), 'resource.write')).toThrow(ForbiddenError)
    try {
      requireCapability(actor('viewer'), 'resource.write')
    } catch (e) {
      expect((e as ForbiddenError).capability).toBe('resource.write')
    }
    expect(() => requireCapability(actor('member'), 'resource.write')).not.toThrow()
  })

  test('isRole validates the enum', () => {
    expect(isRole('admin')).toBe(true)
    expect(isRole('owner')).toBe(false)
    expect(isRole(null)).toBe(false)
  })
})
