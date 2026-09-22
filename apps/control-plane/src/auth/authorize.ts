import { USER_ROLES, type UserRole, type Capability } from '@metamodels/schema'

export type { Capability }
export type Role = UserRole

export interface Actor {
  id: string
  orgId: string
  email: string
  role: Role
  /**
   * OAuth scopes granted to the presented credential, intersected with the role matrix (spec §2.3).
   * `undefined` means "no credential-level restriction" and is reserved for the console cookie
   * session. The bearer path ALWAYS supplies a concrete set, even an empty one — an unscoped token
   * must deny, not inherit full role power (the Portainer impersonation trap C3 exists to avoid).
   */
  grants?: ReadonlySet<Capability>
  /** Which credential acted, for `audit_log.changed_by`: `session` or `token:<client_id>:<jti>`. */
  credential: string
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

export function authorize(
  user: { role: Role; grants?: ReadonlySet<Capability> },
  action: Capability,
): boolean {
  return (MATRIX[user.role]?.[action] ?? false) && (user.grants?.has(action) ?? true)
}

export function requireCapability(user: Actor, action: Capability): void {
  if (!authorize(user, action)) throw new ForbiddenError(action)
}

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (USER_ROLES as readonly string[]).includes(v)
}
