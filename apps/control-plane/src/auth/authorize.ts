import { USER_ROLES, type UserRole } from '@metamodels/schema'

export type Role = UserRole
export type Capability = 'read' | 'resource.write' | 'user.manage' | 'license.manage'

export interface Actor {
  id: string
  orgId: string
  email: string
  role: Role
}

const MATRIX = {
  admin: { read: true, 'resource.write': true, 'user.manage': true, 'license.manage': true },
  member: { read: true, 'resource.write': true, 'user.manage': false, 'license.manage': false },
  viewer: { read: true, 'resource.write': false, 'user.manage': false, 'license.manage': false },
} satisfies Record<Role, Record<Capability, boolean>>

export class ForbiddenError extends Error {
  readonly capability: Capability
  constructor(capability: Capability) {
    super(`forbidden: missing capability '${capability}'`)
    this.name = 'ForbiddenError'
    this.capability = capability
  }
}

export function authorize(user: { role: Role }, action: Capability): boolean {
  return MATRIX[user.role]?.[action] ?? false
}

export function requireCapability(user: Actor, action: Capability): void {
  if (!authorize(user, action)) throw new ForbiddenError(action)
}

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (USER_ROLES as readonly string[]).includes(v)
}
