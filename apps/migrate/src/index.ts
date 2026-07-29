import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

// apps/migrate/src/ -> repo root is three levels up, then the frozen drizzle folder.
const migrationsFolder = fileURLToPath(new URL('../../../packages/schema/drizzle', import.meta.url))

export function loadDatabaseUrl(env: Record<string, string | undefined>): string {
  const url = env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required')
  return url
}

export async function runMigrations(databaseUrl: string): Promise<void> {
  const client = postgres(databaseUrl, { max: 1 })
  try {
    await migrate(drizzle(client), { migrationsFolder })
  } finally {
    await client.end()
  }
}

// Only run when executed directly (tsx src/index.ts), not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith('index.ts')) {
  runMigrations(loadDatabaseUrl(process.env))
    .then(() => {
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
