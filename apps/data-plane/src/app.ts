import { Hono } from 'hono'
import type { BreedRegistry, RequestCtx } from '@metamodels/connectors'
import { hashApiKey } from '@metamodels/schema'
import type { ConfigStore } from './config/config-store.js'
import type { RateLimit } from './config/types.js'
import type { RateLimiter } from './ratelimit/rate-limiter.js'
import type { MeterSink } from './meter/meter-sink.js'
import { proxyToUpstream, type FetchImpl } from './proxy/proxy.js'

export interface AppDeps {
  configStore: ConfigStore
  rateLimiter: RateLimiter
  meterSink: MeterSink
  registry: BreedRegistry
  fetchImpl?: FetchImpl
  defaultRateLimit?: RateLimit
}

const DEFAULT_RATE_LIMIT: RateLimit = { windowSec: 60, max: 60 }

function extractKey(header: string | undefined, xApiKey: string | undefined): string | null {
  if (header && header.startsWith('Bearer ')) return header.slice('Bearer '.length).trim()
  if (xApiKey) return xApiKey.trim()
  return null
}

export function createApp(deps: AppDeps): { app: Hono; drainMeters: () => Promise<void> } {
  const app = new Hono()
  const defaultLimit = deps.defaultRateLimit ?? DEFAULT_RATE_LIMIT
  const pending = new Set<Promise<void>>()

  app.all('/p/:slug/*', async (c) => {
    const slug = c.req.param('slug')
    const upstreamPath = '/' + c.req.path.split('/').slice(3).join('/')

    // 1. Authenticate
    const plaintext = extractKey(c.req.header('authorization'), c.req.header('x-api-key'))
    if (!plaintext) return c.json({ error: 'missing api key' }, 401)
    const resolvedKey = await deps.configStore.resolveKeyByHash(hashApiKey(plaintext))
    if (!resolvedKey) return c.json({ error: 'invalid api key' }, 401)
    if (resolvedKey.expiresAt && resolvedKey.expiresAt.getTime() < Date.now()) {
      return c.json({ error: 'expired api key' }, 401)
    }

    // 2. Resolve paddock
    const paddock = await deps.configStore.getPaddockBySlug(slug)
    if (!paddock || paddock.status !== 'active') return c.json({ error: 'unknown paddock' }, 404)
    if (!resolvedKey.paddockSlugs.includes(slug)) return c.json({ error: 'key not scoped to paddock' }, 403)

    const breed = deps.registry.get(paddock.breedId)

    // 3. Rate limit
    const limit = resolvedKey.overrides?.rateLimit ?? paddock.fence.rateLimit ?? defaultLimit
    const rl = await deps.rateLimiter.check(`${resolvedKey.keyId}:${paddock.paddockId}`, limit)
    if (!rl.allowed) {
      c.header('retry-after', String(rl.retryAfterSec))
      return c.json({ error: 'rate limit exceeded' }, 429)
    }

    // 4. Parse body + build context
    const contentType = c.req.header('content-type') ?? ''
    let body: unknown
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      body = contentType.includes('application/json')
        ? await c.req.json().catch(() => undefined)
        : await c.req.text().catch(() => undefined)
    }
    const ctx: RequestCtx = {
      method: c.req.method,
      path: upstreamPath,
      headers: contentType ? { 'content-type': contentType } : {},
      body,
      paddockSlug: slug,
    }

    // 5. Guard
    const fence = breed.constraintSchema.parse(paddock.fence.constraintJson)
    const guard = await breed.guard(ctx, fence)
    if (!guard.ok) return c.json({ error: guard.reason }, guard.status)

    // 6. Proxy + meter (fire-and-forget metering, drainable for tests)
    const { response, metering } = await proxyToUpstream(paddock.flock, guard.request, { fetchImpl: deps.fetchImpl })
    const meterTask = metering
      .then((upstream) => {
        const events = breed.meter(ctx, upstream).map((e) => ({
          orgId: paddock.orgId, keyId: resolvedKey.keyId, paddockId: paddock.paddockId,
          breedId: paddock.breedId, dim: e.dim, value: e.value, at: e.at,
        }))
        return events.length ? deps.meterSink.emit(events) : undefined
      })
      .catch(() => undefined)
      .then(() => undefined)
    pending.add(meterTask)
    meterTask.finally(() => pending.delete(meterTask))

    return response
  })

  return { app, drainMeters: async () => { await Promise.all([...pending]) } }
}
