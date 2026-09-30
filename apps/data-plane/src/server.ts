import { serve } from '@hono/node-server'
import { drizzle } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import Redis from 'ioredis'
import * as schema from '@metamodels/schema'
import { requireOrigin } from '@metamodels/schema'
import { createAccessTokenVerifier } from '@metamodels/schema/access-token'
import { loadSealKeyring, type SealKeyring } from '@metamodels/schema/sealed'
import { createApp } from './app.js'
import { buildRegistry } from './breeds.js'
import { DrizzleConfigStore, type ConfigStore } from './config/config-store.js'
import { CachingConfigStore } from './config/caching-config-store.js'
import { subscribeConfigInvalidation } from './config/config-invalidation-subscriber.js'
import { InMemoryRateLimiter, type RateLimiter } from './ratelimit/rate-limiter.js'
import { RedisRateLimiter } from './ratelimit/redis-rate-limiter.js'
import { InMemoryMeterSink, type MeterSink } from './meter/meter-sink.js'
import { RedisMeterSink } from './meter/redis-meter-sink.js'
import { DrizzleUsageReader } from './meter/usage-reader.js'
import { PostgresJobStore } from './jobs/postgres-job-store.js'

export interface ServerConfig {
  databaseUrl: string
  redisUrl?: string
  port: number
  sealKeys: SealKeyring
  /** `DATA_PLANE_URL`: this service's public origin, the base of every MCP resource (M4 D2). */
  dataPlaneUrl: string
  /** `OIDC_ISSUER`: the `iss` every MCP access token must carry. */
  oidcIssuer: string
  /** Where to fetch the OP's JWKS from inside the deployment. Defaults to the issuer. */
  oidcInternalUrl: string
}

export function loadServerConfig(env: Record<string, string | undefined>): ServerConfig {
  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  const port = env.PORT ? Number(env.PORT) : 8787
  if (Number.isNaN(port)) throw new Error('PORT must be a number')
  const oidcIssuer = requireOrigin('OIDC_ISSUER', env.OIDC_ISSUER)
  // Required at boot even with no credential stored yet: a missing key should stop the deploy, not
  // surface later as one paddock's 503.
  return {
    databaseUrl,
    redisUrl: env.REDIS_URL,
    port,
    sealKeys: loadSealKeyring(env),
    dataPlaneUrl: requireOrigin('DATA_PLANE_URL', env.DATA_PLANE_URL),
    oidcIssuer,
    oidcInternalUrl: env.OIDC_INTERNAL_URL ? requireOrigin('OIDC_INTERNAL_URL', env.OIDC_INTERNAL_URL) : oidcIssuer,
  }
}

export function startServer(cfg: ServerConfig): void {
  const client = postgres(cfg.databaseUrl)
  const db = drizzle(client, { schema })

  // Redis-backed infra in production (durable + cross-instance atomic); an
  // in-memory fallback keeps single-process dev runnable without Redis. The
  // job store and usage reader are always Postgres-backed (durable).
  let rateLimiter: RateLimiter
  let meterSink: MeterSink
  let redis: Redis | undefined
  if (cfg.redisUrl) {
    redis = new Redis(cfg.redisUrl)
    rateLimiter = new RedisRateLimiter(redis)
    meterSink = new RedisMeterSink(redis)
  } else {
    // In-memory mode has no worker draining the stream into usage_rollup, so the quota gate
    // always reads 0 used and is effectively unenforced here (dev-only single-process runs).
    rateLimiter = new InMemoryRateLimiter()
    meterSink = new InMemoryMeterSink()
  }

  // Caching requires the invalidation channel: with Redis, wrap the store and subscribe to
  // control-plane config writes on a duplicated (subscriber-mode) connection. Without Redis,
  // there is no invalidation path, so serve config uncached to avoid staleness.
  const baseStore = new DrizzleConfigStore(db, cfg.sealKeys)
  let configStore: ConfigStore = baseStore
  if (redis) {
    const caching = new CachingConfigStore(baseStore)
    const sub = redis.duplicate()
    sub.on('error', (e) => {
      // eslint-disable-next-line no-console
      console.error('[config-invalidation] subscriber redis error:', e)
    })
    subscribeConfigInvalidation(sub, caching)
    configStore = caching
  }

  const { app } = createApp({
    configStore,
    rateLimiter,
    meterSink,
    registry: buildRegistry(),
    jobStore: new PostgresJobStore(db),
    usageReader: new DrizzleUsageReader(db),
    mcp: {
      dataPlaneUrl: cfg.dataPlaneUrl,
      oidcIssuer: cfg.oidcIssuer,
      // `iss` is the public issuer; the key set is fetched over the deployment's network: the OP's
      // published `${issuer}/jwks` re-homed onto OIDC_INTERNAL_URL, as the control plane's onOrigin does.
      verify: createAccessTokenVerifier({ issuer: cfg.oidcIssuer, jwksUrl: `${cfg.oidcInternalUrl}/jwks`, typ: 'at+jwt' }),
    },
    readiness: async () => {
      await db.execute(sql`select 1`)
      if (redis) await redis.ping()
      return true
    },
  })

  serve({ fetch: app.fetch, port: cfg.port })
  // eslint-disable-next-line no-console
  console.log(`metamodels data-plane listening on :${cfg.port}${cfg.redisUrl ? ' (redis)' : ' (in-memory)'}`)
}

// Only run when executed directly, not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  startServer(loadServerConfig(process.env))
}
