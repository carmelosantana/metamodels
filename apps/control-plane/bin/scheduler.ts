import { getDb } from '../src/server/db'
import { LemonSqueezyClient } from '../src/server/ls-client'
import { licenseSecret, revalidateAllEntitlements } from '../src/server/license-service'
import { buildBreedRegistry, probeAllFlocks } from '../src/server/flock-health'
import { upstreamAuthKeys } from '../src/server/seal-keys'
import { DEFAULT_HEALTH_INTERVAL_MS, healthPassEnabled, resolveIntervalMs } from '../src/server/scheduler'

async function main(): Promise<void> {
  const db = getDb() // throws if DATABASE_URL is unset
  const secret = licenseSecret() // throws if LICENSE_KEY_SECRET is unset/<16
  const health = healthPassEnabled(process.env)
  // A malformed key still fails at start, not on the first pass; a missing one only turns health off.
  if (health) upstreamAuthKeys()
  const intervalMs = resolveIntervalMs(process.env.SCHEDULER_INTERVAL_MS)
  const healthIntervalMs = resolveIntervalMs(process.env.FLOCK_HEALTH_INTERVAL_MS, DEFAULT_HEALTH_INTERVAL_MS)
  const registry = buildBreedRegistry()

  // A stop signal ends every wait at once, so `docker stop` does not have to kill a 12-hour sleep.
  const stopped = new AbortController()
  const stop = () => stopped.abort()
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  const sleep = (ms: number) => new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    stopped.signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
  })

  // Runs one pass immediately, then every `ms` until a stop signal. A crashed pass is retried next time.
  async function every(ms: number, name: string, pass: () => Promise<string>): Promise<void> {
    while (!stopped.signal.aborted) {
      try {
        // eslint-disable-next-line no-console
        console.log(await pass())
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`${name} pass crashed; will retry next interval`, err)
      }
      if (stopped.signal.aborted) break
      await sleep(ms)
    }
  }

  // eslint-disable-next-line no-console
  console.log(`metamodels scheduler: revalidating every ${intervalMs}ms, ` +
    (health ? `probing flocks every ${healthIntervalMs}ms` : 'flock health OFF'))
  if (!health) {
    // eslint-disable-next-line no-console
    console.warn('metamodels scheduler: UPSTREAM_AUTH_KEY is not set, so flock health is not probed. ' +
      'Take the current stack file, which passes it to the scheduler (docs/DEPLOY.md, "Upgrading from 0.6.1").')
  }

  await Promise.all([
    every(intervalMs, 'revalidation', async () => {
      const res = await revalidateAllEntitlements(db, { ls: new LemonSqueezyClient(), secret, nowMs: Date.now() })
      return `revalidation pass: ${res.ok}/${res.total} ok, ${res.failed} failed`
    }),
    ...(health
      ? [every(healthIntervalMs, 'flock health', async () => {
        const res = await probeAllFlocks(registry, db)
        return `flock health pass: ${res.ok}/${res.total} healthy`
      })]
      : []),
  ])
  process.exit(0)
}

// Only run when executed directly, not when imported.
if (process.argv[1] && process.argv[1].endsWith('scheduler.ts')) {
  void main()
}
