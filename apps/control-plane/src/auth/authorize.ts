export type Role = 'admin' | 'member' | 'viewer'
export type Capability = 'read' | 'resource.write' | 'user.manage' | 'license.manage'

export interface Actor {
  id: string
  orgId: string
  email: string
  role: Role
}

const MATRIX: Record<Role, Record<Capability, boolean>> = {
  admin: { read: true, 'resource.write': true, 'user.manage': true, 'license.manage': true },
  member: { read: true, 'resource.write': true, 'user.manage': false, 'license.manage': false },
  viewer: { read: true, 'resource.write': false, 'user.manage': false, 'license.manage': false },
}

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
  return v === 'admin' || v === 'member' || v === 'viewer'
}
