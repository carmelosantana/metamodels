export const BREED_IDS = ['ollama', 'comfyui'] as const
export const ROUTE_CLASSES = ['read', 'infer', 'mutate'] as const
export const METER_DIMS = ['tokens_in', 'tokens_out', 'jobs', 'gpu_ms', 'images'] as const
export const PADDOCK_STATUS = ['active', 'disabled'] as const
export const PADDOCK_THEMES = ['plain', 'metaboy'] as const
export const KEY_STATUS = ['active', 'revoked'] as const
export const USER_ROLES = ['admin', 'member', 'viewer'] as const
export const USER_STATUS = ['active', 'deactivated'] as const

export type BreedId = (typeof BREED_IDS)[number]
export type RouteClass = (typeof ROUTE_CLASSES)[number]
export type MeterDim = (typeof METER_DIMS)[number]
export type UserRole = (typeof USER_ROLES)[number]
export type UserStatus = (typeof USER_STATUS)[number]
export type PaddockTheme = (typeof PADDOCK_THEMES)[number]

export const KEY_KINDS = ['live', 'oauth'] as const
export type KeyKind = (typeof KEY_KINDS)[number]

/**
 * A paddock's public `/p/:slug` handle: lowercase letters, digits and hyphens, no leading or trailing
 * hyphen, at most `PADDOCK_SLUG_MAX` characters. One definition: the console validates new slugs
 * with it, and `parseMcpResource` refuses a resource indicator whose slug a paddock could not have.
 */
export const PADDOCK_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
export const PADDOCK_SLUG_MAX = 64
