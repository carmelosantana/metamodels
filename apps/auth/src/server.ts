import { createServer, type Server } from 'node:http'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from '@metamodels/schema'
import { sweepExpired } from './adapter.js'
import { loadAuthConfig, type AuthConfig } from './config.js'
import type { Db } from './db.js'
import { createProvider } from './provider.js'

const SWEEP_INTERVAL_MS = 60 * 60 * 1000

/** Start the OP. `db` is injectable for tests; production builds a postgres-js client from DATABASE_URL. */
export function startAuthServer(cfg: AuthConfig, db: Db = drizzle(postgres(cfg.databaseUrl), { schema })): Server {
  if (!cfg.signingKeyPem) {
    // eslint-disable-next-line no-console
    console.warn('[auth] OIDC_ALLOW_EPHEMERAL_KEY: signing with a throwaway key — every token dies on restart. Development only.')
  }
  const server = createServer(createProvider(cfg, db).callback())

  const sweep = setInterval(() => {
    // eslint-disable-next-line no-console
    sweepExpired(db).catch((err) => console.error('[auth] expired-row sweep failed:', err))
  }, SWEEP_INTERVAL_MS)
  sweep.unref()
  server.on('close', () => clearInterval(sweep))

  server.listen(cfg.port, () => {
    // eslint-disable-next-line no-console
    console.log(`metamodels auth listening on :${cfg.port} (issuer ${cfg.issuer})`)
  })
  return server
}

// Only run when executed directly, not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  startAuthServer(loadAuthConfig(process.env))
}
