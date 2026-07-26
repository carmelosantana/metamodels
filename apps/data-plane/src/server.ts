import { serve } from '@hono/node-server'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from '@metamodels/schema'
import { createApp } from './app.js'
import { buildRegistry } from './breeds.js'
import { DrizzleConfigStore } from './config/config-store.js'
import { InMemoryRateLimiter } from './ratelimit/rate-limiter.js'
import { InMemoryMeterSink } from './meter/meter-sink.js'

export interface ServerConfig {
  databaseUrl: string
  port: number
}

export function loadServerConfig(env: Record<string, string | undefined>): ServerConfig {
  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  const port = env.PORT ? Number(env.PORT) : 8787
  return { databaseUrl, port }
}

export function startServer(cfg: ServerConfig): void {
  const sql = postgres(cfg.databaseUrl)
  const db = drizzle(sql, { schema })
  const { app } = createApp({
    configStore: new DrizzleConfigStore(db),
    rateLimiter: new InMemoryRateLimiter(),
    meterSink: new InMemoryMeterSink(),
    registry: buildRegistry(),
  })
  serve({ fetch: app.fetch, port: cfg.port })
  // eslint-disable-next-line no-console
  console.log(`metamodels data-plane listening on :${cfg.port}`)
}

// Only run when executed directly, not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  startServer(loadServerConfig(process.env))
}
