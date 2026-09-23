import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { loadSealKeyring, type SealKeyring } from '@metamodels/schema/sealed'
import { resealUpstreamAuth, VACUUM_FLOCK_SQL, type ResealReport } from '@metamodels/schema/reseal'

// apps/migrate/src/ -> repo root is three levels up, then the frozen drizzle folder.
const migrationsFolder = fileURLToPath(new URL('../../../packages/schema/drizzle', import.meta.url))

export function loadDatabaseUrl(env: Record<string, string | undefined>): string {
  const url = env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required')
  return url
}

/** Log lines for a reseal pass. An unreadable row warns and names its flock; it never fails the run. */
export function describeReseal(r: ResealReport): { info: string[]; warn: string[] } {
  const info = r.sealed || r.resealed
    ? [`metamodels: sealed ${r.sealed} plaintext upstream credential(s); re-sealed ${r.resealed} under the current key`]
    : []
  const warn = r.unreadable.map((u) =>
    `metamodels: flock ${u.id} (${u.name}): upstream credential cannot be opened (${u.reason}). ` +
    (u.reason === 'unknown-key'
      // Sealed under a key this stack does not hold (a restore under another key): the old key
      // recovers it, if it still exists.
      ? 'Its requests fail until either the key that sealed it is added to UPSTREAM_AUTH_PREVIOUS_KEYS, ' +
        `or a new credential is sent with PUT /api/admin/v1/flocks/${u.id}.`
      // Moved from another row, altered, or not an envelope: no key opens it, so only a new
      // credential helps.
      : `No key will open it. Its requests fail until a new credential is sent with PUT /api/admin/v1/flocks/${u.id}.`))
  if (typeof r.vacuum === 'object') {
    // The re-encryption committed; only the rewrite that clears the old row versions did not, and a
    // re-run will not retry it (it finds nothing left to re-encrypt). So say exactly what to run.
    warn.push(`metamodels: the flock table rewrite failed (${r.vacuum.failed}). The old row versions ` +
      `still hold the previous values; run it by hand: psql "$DATABASE_URL" -c '${VACUUM_FLOCK_SQL}'`)
  }
  return { info, warn }
}

export async function runMigrations(databaseUrl: string, ring: SealKeyring): Promise<ResealReport> {
  const client = postgres(databaseUrl, { max: 1 })
  try {
    const db = drizzle(client)
    await migrate(db, { migrationsFolder })
    // After the SQL and before any other service starts (they wait on this one): the only point at
    // which the upgrade's plaintext rows and a rotation's old-key rows can be brought under the
    // current key with nothing else reading them.
    return await resealUpstreamAuth(db, ring)
  } finally {
    await client.end()
  }
}

// Only run when executed directly (tsx src/index.ts), not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith('index.ts')) {
  // Both loaded before anything touches the database: a missing or malformed key fails here, not
  // halfway through, between a migration and the sweep that has to follow it.
  const databaseUrl = loadDatabaseUrl(process.env)
  const ring = loadSealKeyring(process.env)
  runMigrations(databaseUrl, ring)
    .then((report) => {
      const { info, warn } = describeReseal(report)
      // eslint-disable-next-line no-console
      for (const line of info) console.log(line)
      // eslint-disable-next-line no-console
      for (const line of warn) console.warn(line)
      // eslint-disable-next-line no-console
      console.log('metamodels: migrations applied')
      process.exit(0)
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('metamodels: migration failed', err)
      process.exit(1)
    })
}
