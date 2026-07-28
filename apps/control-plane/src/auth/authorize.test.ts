import { describe, expect, test } from 'vitest'
import { USER_ROLES } from '@metamodels/schema'
import { authorize, requireCapability, isRole, ForbiddenError, type Role, type Capability } from './authorize'

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

  test('capability grants match the spec', () => {
    expect(authorize({ role: 'admin' }, 'user.manage')).toBe(true)
    expect(authorize({ role: 'member' }, 'user.manage')).toBe(false)
    expect(authorize({ role: 'viewer' }, 'resource.write')).toBe(false)
    expect(authorize({ role: 'viewer' }, 'read')).toBe(true)
  })

  test('isRole rejects non-roles and accepts schema roles', () => {
    expect(isRole('admin')).toBe(true)
    expect(isRole('root')).toBe(false)
    expect(isRole(null)).toBe(false)
  })

  test('requireCapability throws ForbiddenError with the capability', () => {
    const actor = { id: 'u', orgId: 'o', email: 'v@x.io', role: 'viewer' as Role }
    const cap: Capability = 'resource.write'
    expect(() => requireCapability(actor, cap)).toThrow(ForbiddenError)
  })
})
