/**
 * Next.js runs this once when the server boots. It loads the upstream-credential keyring here, so a
 * missing or malformed `UPSTREAM_AUTH_KEY` stops the console at start-up — as it stops `migrate` and
 * the data plane — rather than surfacing on the first flock credential someone saves or opens.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { upstreamAuthKeys } = await import('./server/seal-keys')
  upstreamAuthKeys()
}
