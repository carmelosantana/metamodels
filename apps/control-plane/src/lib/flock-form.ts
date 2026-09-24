import { z } from 'zod'

/**
 * What the edit drawer does with a stored credential. Absent on the create form, and on an edit of
 * a flock with no credential stored, where a blank field means "none" and a filled one sets it.
 */
const credentialChoice = z.enum(['keep', 'replace', 'remove']).optional()

/**
 * The console's flock form, as `saveFlock` input. A blank credential field is omitted, not sent as
 * `null`: omission means "leave the stored credential alone", and the field is always blank when a
 * form opens, because no read ever returns a credential to pre-fill it with.
 *
 * With a `credential` choice: `keep` omits it, `remove` sends `null`, and `replace` always sends the
 * field — blank included — so an empty replacement is refused by validation instead of silently
 * keeping the old credential.
 */
export function flockFormToInput(fd: FormData) {
  const id = String(fd.get('id') ?? '')
  const choice = credentialChoice.parse(fd.get('credential') ?? undefined)
  const typed = String(fd.get('upstreamAuth') ?? '').trim()
  const credential = choice === 'remove' ? { upstreamAuth: null }
    : choice === 'replace' ? { upstreamAuth: typed }
    : choice === undefined && typed ? { upstreamAuth: typed }
    : {}
  return {
    id: id || undefined,
    breed: String(fd.get('breed') ?? ''),
    name: String(fd.get('name') ?? '').trim(),
    baseUrl: String(fd.get('baseUrl') ?? '').trim(),
    ...credential,
    tlsTrust: String(fd.get('tlsTrust') ?? 'false') === 'true',
  }
}
