/**
 * Identifiers the auth service (the issuer) and the console (a client, and from M2 the admin
 * API's resource server) must agree on byte for byte. One definition, imported by both.
 */

/** The console's OAuth client_id — the `aud` of every console ID token. */
export const CONSOLE_CLIENT_ID = 'metamodels-console'

/** The admin API's RFC 8707 resource indicator — and therefore the `aud` of its access tokens. */
export function adminApiResource(consoleUrl: string): string {
  return `${consoleUrl}/api/admin`
}
