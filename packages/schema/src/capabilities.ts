/**
 * The operator console's capability names.
 *
 * These are ALSO the OAuth scope values the admin-API resource server accepts, so a token's
 * granted scopes map one-to-one onto `requireCapability()` checks (spec §2.2). Renaming one is
 * a breaking change to every issued token.
 */
export const CAPABILITIES = ['read', 'resource.write', 'user.manage', 'license.manage'] as const

export type Capability = (typeof CAPABILITIES)[number]
