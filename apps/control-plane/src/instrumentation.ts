/**
 * Next.js runs this once when the server boots. It loads the upstream-credential keyring here, so a
 * missing or malformed `UPSTREAM_AUTH_KEY` stops the console at start-up — as it stops `migrate` and
 * the data plane — rather than surfacing on the first flock credential someone saves or opens.
 *
 * It must EXIT, not throw: Next 16 catches a rejected `register()`, logs "Failed to prepare
 * server", and goes on listening and answering 500s, so a container would sit "unhealthy" forever
 * instead of stopping where `restart:` and the operator can see it.
 */
export async function register(): Promise<void> {
  // No parameters on purpose: Next calls this, and anything it ever passed must not become `exit`.
  await boot((code) => process.exit(code))
}

/** The work behind `register()`, with `exit` injected so a test can observe it. */
export async function boot(exit: (code: number) => never): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  try {
    const { upstreamAuthKeys } = await import('./server/seal-keys')
    upstreamAuthKeys()
  } catch (e) {
    // The keyring's errors name the variable and never the value, so the message is safe to log.
    // eslint-disable-next-line no-console
    console.error(`metamodels console: refusing to start — ${e instanceof Error ? e.message : String(e)}`)
    exit(1)
  }
}
