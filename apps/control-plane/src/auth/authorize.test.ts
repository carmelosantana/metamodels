import { describe, expect, test } from 'vitest'
import { USER_ROLES } from '@metamodels/schema'
import {
  authorize,
  requireCapability,
  isRole,
  ForbiddenError,
  type Actor,
  type Role,
  type Capability,
} from './authorize'

const actor = (role: Role): Actor => ({ id: 'u1', orgId: 'o1', email: 'a@b.c', role })

describe('authorize role/capability matrix', () => {
  test('every schema USER_ROLES value is a known Role in the matrix', () => {
    // If a role is added to the schema but not the matrix, authorize() would silently deny
    // everything for it — assert each schema role resolves through the matrix deterministically.
    for (const role of USER_ROLES) {
      expect(isRole(role)).toBe(true)
      // 'read' is granted to all three current roles; this proves the row exists (not undefined).
      expect(typeof authorize({ role: role as Role }, 'read')).toBe('boolean')
    }
  })

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
    const cap: Capability = 'resource.write'
    expect(() => requireCapability(actor('viewer'), cap)).toThrow(ForbiddenError)
    try {
      requireCapability(actor('viewer'), cap)
    } catch (e) {
      expect((e as ForbiddenError).capability).toBe('resource.write')
    }
    expect(() => requireCapability(actor('member'), 'resource.write')).not.toThrow()
  })

  test('isRole rejects non-roles and accepts schema roles', () => {
    expect(isRole('admin')).toBe(true)
    expect(isRole('owner')).toBe(false)
    expect(isRole('root')).toBe(false)
    expect(isRole(null)).toBe(false)
  })
})
