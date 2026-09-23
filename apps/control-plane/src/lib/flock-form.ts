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
