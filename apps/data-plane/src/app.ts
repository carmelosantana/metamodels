import { Hono } from 'hono'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type {
  Breed,
  BreedIO,
  BreedRegistry,
  JobStore,
  MeterEvent,
  RequestCtx,
  RewrittenRequest,
  UpstreamResult,
} from '@metamodels/connectors'
import { parseHistory } from '@metamodels/connectors'
import { hashApiKey } from '@metamodels/schema'
import type { ConfigStore } from './config/config-store.js'
import type { RateLimit, ResolvedKey, ResolvedPaddock } from './config/types.js'
import type { RateLimiter } from './ratelimit/rate-limiter.js'
import type { MeterSink, MeterEventRecord } from './meter/meter-sink.js'
import { quotaSchema } from './config/quota.js'
import type { UsageReader } from './meter/usage-reader.js'
import { proxyToUpstream, type FetchImpl } from './proxy/proxy.js'

export interface AppDeps {
  configStore: ConfigStore
  rateLimiter: RateLimiter
  meterSink: MeterSink
  registry: BreedRegistry
  jobStore: JobStore
  usageReader?: UsageReader
  readiness?: () => Promise<boolean>
  fetchImpl?: FetchImpl
  defaultRateLimit?: RateLimit
}

const DEFAULT_RATE_LIMIT: RateLimit = { windowSec: 60, max: 60 }

function extractKey(header: string | undefined, xApiKey: string | undefined): string | null {
  if (header && header.startsWith('Bearer ')) return header.slice('Bearer '.length).trim()
  if (xApiKey) return xApiKey.trim()
  return null
}

interface Scope {
  resolvedKey: ResolvedKey
  paddock: ResolvedPaddock
  breed: Breed<unknown>
}

export function createApp(deps: AppDeps): { app: Hono; drainMeters: () => Promise<void> } {
  const app = new Hono()

  // Liveness: the process is up and serving. Cheap, dependency-free.
  app.get('/healthz', (c) => c.json({ status: 'ok' }))

  // Readiness: dependencies (DB, Redis) are reachable. 503 until they are.
  app.get('/readyz', async (c) => {
    if (!deps.readiness) return c.json({ ready: true })
    try {
      return (await deps.readiness()) ? c.json({ ready: true }) : c.json({ ready: false }, 503)
    } catch {
      return c.json({ ready: false }, 503)
    }
  })

  const defaultLimit = deps.defaultRateLimit ?? DEFAULT_RATE_LIMIT
  const pending = new Set<Promise<void>>()
  const doFetch: FetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init))

  // Shared gates: authenticate the key, resolve the paddock, and scope-check.
  // Returns the resolved scope or a ready-to-send error Response, so the proxy
  // handler and the scoped result route apply identical gates.
  async function resolveScope(
    c: Context,
    slug: string,
  ): Promise<{ ok: true; scope: Scope } | { ok: false; res: Response }> {
    const plaintext = extractKey(c.req.header('authorization'), c.req.header('x-api-key'))
    if (!plaintext) return { ok: false, res: c.json({ error: 'missing api key' }, 401) }
    const resolvedKey = await deps.configStore.resolveKeyByHash(hashApiKey(plaintext))
    if (!resolvedKey) return { ok: false, res: c.json({ error: 'invalid api key' }, 401) }
    if (resolvedKey.expiresAt && resolvedKey.expiresAt.getTime() < Date.now()) {
      return { ok: false, res: c.json({ error: 'expired api key' }, 401) }
    }

    const paddock = await deps.configStore.getPaddockBySlug(slug)
    if (!paddock || paddock.status !== 'active') return { ok: false, res: c.json({ error: 'unknown paddock' }, 404) }
    if (!resolvedKey.paddockSlugs.includes(slug)) {
      return { ok: false, res: c.json({ error: 'key not scoped to paddock' }, 403) }
    }

    return { ok: true, scope: { resolvedKey, paddock, breed: deps.registry.get(paddock.breedId) } }
  }

  // Emit meter events, scoped to a paddock, through the drainable mechanism so
  // tests can await completion deterministically. Errors are swallowed (metering
  // is best-effort and must never fail the request).
  function emitScoped(
    scope: { orgId: string; keyId: string; paddockId: string; breedId: string },
    events: MeterEvent[],
  ): Promise<void> {
    if (events.length === 0) return Promise.resolve()
    const records: MeterEventRecord[] = events.map((e) => ({
      orgId: scope.orgId,
      keyId: scope.keyId,
      paddockId: scope.paddockId,
      breedId: scope.breedId,
      dim: e.dim,
      value: e.value,
      at: e.at,
    }))
    const task = deps.meterSink
      .emit(records)
      .catch(() => undefined)
      .then(() => undefined)
    pending.add(task)
    task.finally(() => pending.delete(task))
    return task
  }

  // Build the capability surface handed to a breed's `handle` hook.
  function buildIo(resolvedKey: ResolvedKey, paddock: ResolvedPaddock): BreedIO {
    const base = paddock.flock.baseUrl.replace(/\/$/, '')
    return {
      ids: { orgId: paddock.orgId, keyId: resolvedKey.keyId, paddockId: paddock.paddockId },
      flock: paddock.flock,
      async upstream(req: RewrittenRequest): Promise<UpstreamResult> {
        // Normalize a transport failure into a 502 so an unguarded breed call
        // can never surface as an unhandled 500.
        try {
          const { metering } = await proxyToUpstream(paddock.flock, req, { fetchImpl: deps.fetchImpl })
          return await metering
        } catch {
          return { status: 502, headers: {}, body: undefined, finalFrame: undefined }
        }
      },
      upstreamRaw(path: string, init: RequestInit): Promise<Response> {
        return doFetch(base + path, init)
      },
      emitMeter(events: MeterEvent[]): Promise<void> {
        return emitScoped(
          { orgId: paddock.orgId, keyId: resolvedKey.keyId, paddockId: paddock.paddockId, breedId: paddock.breedId },
          events,
        )
      },
      jobs: deps.jobStore,
    }
  }

  // Scoped result route: consumers poll their own job by id and receive a
  // scoped `{ done, images }` view — never the raw /history payload or a direct
  // /view URL. A job belonging to another key returns 404 (not 403) so the route
  // does not leak the existence of other keys' jobs.
  app.get('/p/:slug/result/:jobId', async (c) => {
    const slug = c.req.param('slug')
    const jobId = c.req.param('jobId')

    const gate = await resolveScope(c, slug)
    if (!gate.ok) return gate.res
    const { resolvedKey, paddock } = gate.scope

    const job = await deps.jobStore.get(jobId)
    if (!job || job.keyId !== resolvedKey.keyId || job.paddockId !== paddock.paddockId) {
      return c.json({ error: 'not found' }, 404)
    }

    // Fetch the upstream history for this job (server-side only; never exposed).
    let historyBody: unknown
    try {
      const { metering } = await proxyToUpstream(
        paddock.flock,
        { method: 'GET', path: `/history/${jobId}`, headers: {}, body: undefined },
        { fetchImpl: deps.fetchImpl },
      )
      historyBody = (await metering).body
    } catch {
      historyBody = undefined
    }

    const outcome = parseHistory(historyBody, jobId)

    // Meter images + gpu_ms exactly once, at completion. markMetered is a
    // compare-and-set: mark BEFORE emitting and emit only when this poll won the
    // transition, so concurrent polls can never double-meter (only one wins).
    if (outcome.done) {
      const won = await deps.jobStore.markMetered(jobId)
      if (won) {
        const at = Date.now()
        await emitScoped(
          { orgId: paddock.orgId, keyId: resolvedKey.keyId, paddockId: paddock.paddockId, breedId: paddock.breedId },
          [
            { dim: 'images', value: outcome.images.length, at },
            { dim: 'gpu_ms', value: outcome.gpuMs, at },
          ],
        )
      }
    }

    return c.json({ done: outcome.done, images: outcome.images })
  })

  app.all('/p/:slug/*', async (c) => {
    const slug = c.req.param('slug')
    const upstreamPath = '/' + c.req.path.split('/').slice(3).join('/')

    // 1-2. Authenticate + resolve paddock + scope check.
    const gate = await resolveScope(c, slug)
    if (!gate.ok) return gate.res
    const { resolvedKey, paddock, breed } = gate.scope

    // 3. Rate limit
    const limit = resolvedKey.overrides?.rateLimit ?? paddock.fence.rateLimit ?? defaultLimit
    const rl = await deps.rateLimiter.check(`${resolvedKey.keyId}:${paddock.paddockId}`, limit)
    if (!rl.allowed) {
      c.header('retry-after', String(rl.retryAfterSec))
      return c.json({ error: 'rate limit exceeded' }, 429)
    }

    // 3b. Quota caps (hard). Read the current period's rollup total per rule and
    //     reject at/over the cap. Enforced against already-aggregated usage, so a
    //     single in-flight request may cross the cap before it is counted
    //     (bounded by worker lag) — acceptable for v1; see Plan 4 carry-forward.
    if (deps.usageReader && paddock.fence.quota != null) {
      const parsed = quotaSchema.safeParse(paddock.fence.quota)
      if (parsed.success) {
        const now = Date.now()
        for (const rule of parsed.data) {
          const used = await deps.usageReader.periodUsage(resolvedKey.keyId, paddock.paddockId, rule.dim, rule.period, now)
          if (used >= rule.max) {
            return c.json({ error: 'quota exceeded', dim: rule.dim }, 429)
          }
        }
      }
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

    // 5. Parse fence
    const fence = breed.constraintSchema.parse(paddock.fence.constraintJson)

    // 6. Breeds that own a multi-step flow implement `handle`. Delegate the
    //    entire request to it — EXCEPT a request that targets one of the breed's
    //    declared direct upstream routes (all exposeByDefault:false). Those are
    //    bypass attempts and must be denied by `guard` (defense in depth), so a
    //    consumer can never reach a raw upstream endpoint (e.g. /prompt) directly.
    if (breed.handle) {
      const direct = breed.routes.find(
        (r) =>
          r.method === ctx.method &&
          !r.exposeByDefault &&
          (upstreamPath === r.path || upstreamPath.startsWith(r.path + '/')),
      )
      if (direct) {
        const guard = await breed.guard(ctx, fence)
        if (!guard.ok) return c.json({ error: guard.reason }, guard.status)
      }
      const io = buildIo(resolvedKey, paddock)
      const result = await breed.handle(ctx, fence, io)
      return c.json(result.body as Record<string, unknown>, result.status as ContentfulStatusCode)
    }

    // 7. Generic path (Ollama): guard → proxy → meter.
    const guard = await breed.guard(ctx, fence)
    if (!guard.ok) return c.json({ error: guard.reason }, guard.status)

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
