import { getDb } from '../src/server/db'
import { LemonSqueezyClient } from '../src/server/ls-client'
import { licenseSecret, revalidateAllEntitlements } from '../src/server/license-service'
import { resolveIntervalMs } from '../src/server/scheduler'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  const db = getDb() // throws if DATABASE_URL is unset
  const secret = licenseSecret() // throws if LICENSE_KEY_SECRET is unset/<16
  const intervalMs = resolveIntervalMs(process.env.SCHEDULER_INTERVAL_MS)

  let stopping = false
  const stop = () => { stopping = true }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)

  // eslint-disable-next-line no-console
  console.log(`metamodels scheduler: revalidating every ${intervalMs}ms`)

  // Run one pass immediately on start, then every intervalMs until a stop signal.
  while (!stopping) {
    try {
      const deps = { ls: new LemonSqueezyClient(), secret, nowMs: Date.now() }
      const res = await revalidateAllEntitlements(db, deps)
      // eslint-disable-next-line no-console
      console.log(`revalidation pass: ${res.ok}/${res.total} ok, ${res.failed} failed`)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('revalidation pass crashed; will retry next interval', err)
    }
    if (stopping) break
    await sleep(intervalMs)
  }
}

// Only run when executed directly, not when imported.
if (process.argv[1] && process.argv[1].endsWith('scheduler.ts')) {
  void main()
}
