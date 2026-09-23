import { ZodError } from 'zod'
import { ForbiddenError } from '../auth/authorize'
import { CredentialRebindError, NotFoundError } from './flocks-service'

/**
 * What the console shows when a flock save fails. It lives in `server/`, not `lib/`, because it
 * needs the service's error classes, and those import the database and the keyring.
 *
 * Only errors the service raises on purpose are echoed. Anything else, such as a driver error, can
 * carry the query and its parameters, including the sealed credential, so it gets a fixed string.
 * A validation error lists paths and messages, which zod builds without the credential's value.
 */
export function saveFlockErrorMessage(e: unknown): string {
  if (e instanceof ZodError) {
    return e.issues.length
      ? e.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')
      : 'Invalid flock details'
  }
  // The same refusal as the API's 409, in words for the form: the API's message names the
  // `upstreamAuth` field and `null`, neither of which a console user can send by name.
  if (e instanceof CredentialRebindError) {
    return 'Re-enter the upstream credential to change the base URL or to trust self-signed TLS.'
  }
  if (e instanceof ForbiddenError || e instanceof NotFoundError) return e.message
  return 'Failed to save flock'
}
