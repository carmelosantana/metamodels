import { ZodError } from 'zod'
import { ForbiddenError } from '../auth/authorize'
import { CredentialRebindError, NotFoundError } from '../server/flocks-service'

/**
 * The console's flock form, as `saveFlock` input. A blank credential field is omitted, not sent as
 * `null`: omission means "leave the stored credential alone", and the field is always blank when a
 * form opens, because no read ever returns a credential to pre-fill it with.
 */
export function flockFormToInput(fd: FormData) {
  const id = String(fd.get('id') ?? '')
  const upstreamAuth = String(fd.get('upstreamAuth') ?? '').trim()
  return {
    id: id || undefined,
    breed: String(fd.get('breed') ?? ''),
    name: String(fd.get('name') ?? '').trim(),
    baseUrl: String(fd.get('baseUrl') ?? '').trim(),
    ...(upstreamAuth ? { upstreamAuth } : {}),
    tlsTrust: String(fd.get('tlsTrust') ?? 'false') === 'true',
  }
}

/**
 * What the console shows when a save fails. Only errors the service raises on purpose are echoed.
 * Anything else, such as a driver error, can carry the query and its parameters, including the
 * sealed credential, so it gets a fixed string instead. A validation error lists paths and
 * messages, which zod builds without the input values.
 */
export function saveFlockErrorMessage(e: unknown): string {
  if (e instanceof ZodError) {
    return e.issues.length
      ? e.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')
      : 'Invalid flock details'
  }
  if (e instanceof ForbiddenError || e instanceof NotFoundError || e instanceof CredentialRebindError) return e.message
  return 'Failed to save flock'
}
