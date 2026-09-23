/**
 * Identifiers the auth service (the issuer) and the console (a client, and from M2 the admin
 * API's resource server) must agree on byte for byte. One definition, imported by both.
 */

/** The console's OAuth client_id — the `aud` of every console ID token. */
export const CONSOLE_CLIENT_ID = 'metamodels-console'

/** The admin CLI's OAuth client_id — the `client_id` claim of every access token the CLI holds. */
export const CLI_CLIENT_ID = 'metamodels-cli'

/** The admin API's RFC 8707 resource indicator — and therefore the `aud` of its access tokens. */
export function adminApiResource(consoleUrl: string): string {
  return `${consoleUrl}/api/admin`
}

/**
 * How long an operator stays signed in: the console's `mm_session` lifetime AND the auth
 * service's OP session lifetime. They must match — an OP session that outlives the console
 * session would silently sign the browser back in, with no password, after the console session
 * ends.
 */
export const OPERATOR_SESSION_TTL_MS = 12 * 60 * 60 * 1000
