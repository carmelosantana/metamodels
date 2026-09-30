import type {
  Breed, BreedIO, BreedRegistry, JobStore, MeterEvent, RequestCtx, RewrittenRequest, UpstreamResult,
} from '@metamodels/connectors'
import { parseHistory } from '@metamodels/connectors'
import type { ConfigStore } from './config/config-store.js'
import { quotaSchema } from './config/quota.js'
import type { RateLimit, ResolvedKey, ResolvedPaddock } from './config/types.js'
import type { MeterEventRecord, MeterSink } from './meter/meter-sink.js'
import type { UsageReader } from './meter/usage-reader.js'
import { proxyToUpstream, rawToUpstream, type FetchImpl } from './proxy/proxy.js'
import type { RateLimiter } from './ratelimit/rate-limiter.js'

/** An authenticated caller, the paddock it may use, and that paddock's breed. */
export interface Scope {
  resolvedKey: ResolvedKey
  paddock: ResolvedPaddock
  breed: Breed<unknown>
}

/** A gate's refusal, before it is rendered: the proxy sends it as JSON, MCP as `isError`. */
export interface Refusal {
  status: number
  body: Record<string, unknown>
  headers?: Record<string, string>
}

/** The short reason a refusal carries — the string the proxy returns as `error`. */
export function refusalReason(r: Refusal): string {
  return typeof r.body.error === 'string' ? r.body.error : `refused (${r.status})`
}

export type BreedOutcome =
  | { kind: 'refused'; refusal: Refusal }
  | { kind: 'handled'; status: number; body: unknown }
  | { kind: 'proxied'; response: Response; metering: Promise<UpstreamResult> }

export interface PipelineDeps {
  configStore: ConfigStore
  rateLimiter: RateLimiter
  meterSink: MeterSink
  registry: BreedRegistry
  jobStore: JobStore
  usageReader?: UsageReader
  fetchImpl?: FetchImpl
  defaultRateLimit?: RateLimit
}

/**
 * The gates every request to a paddock passes after its caller is authenticated, shared by the
 * streaming proxy (`ALL /p/:slug/*`, `GET /p/:slug/result/:jobId`) and MCP (`POST /p/:slug/mcp`), so
 * that "inherited unchanged" (spec M4 §2) is true by construction rather than by copy.
 */
export interface Pipeline {
  /** Unknown or inactive paddock 404; key not scoped 403; unopenable upstream credential 503. */
  paddockScope(resolvedKey: ResolvedKey, slug: string): Promise<{ ok: true; scope: Scope } | { ok: false; refusal: Refusal }>
  /** Rate limit, then quota. Null when the request may proceed. */
  limits(scope: Scope): Promise<Refusal | null>
  /** `guard()` then `handle` or `proxyToUpstream`, then `meter`. A transport failure to upstream throws, as before. */
  run(scope: Scope, ctx: RequestCtx): Promise<BreedOutcome>
  /** The scoped result view of one of this key's jobs on this paddock; meters images and gpu_ms once. */
  jobResult(scope: Scope, jobId: string): Promise<{ status: number; body: unknown }>
  /** A raw call to the paddock's flock with its credential (`/view` for MCP image bytes). */
  raw(scope: Scope, path: string, init: RequestInit): Promise<Response>
  /** Resolves once every in-flight meter emission has settled. */
  drain(): Promise<void>
}

const DEFAULT_RATE_LIMIT: RateLimit = { windowSec: 60, max: 60 }

export function createPipeline(deps: PipelineDeps): Pipeline {
  const defaultLimit = deps.defaultRateLimit ?? DEFAULT_RATE_LIMIT
  const pending = new Set<Promise<void>>()

  function track(task: Promise<void>): Promise<void> {
    pending.add(task)
    task.finally(() => pending.delete(task))
    return task
  }

  // Emit meter events, scoped to a paddock, through the drainable mechanism so
  // tests can await completion deterministically. Errors are swallowed (metering
  // is best-effort and must never fail the request).
  function emitScoped(scope: Scope, events: MeterEvent[]): Promise<void> {
    if (events.length === 0) return Promise.resolve()
    const { resolvedKey, paddock } = scope
    const records: MeterEventRecord[] = events.map((e) => ({
      orgId: paddock.orgId,
      keyId: resolvedKey.keyId,
      paddockId: paddock.paddockId,
      breedId: paddock.breedId,
      dim: e.dim,
      value: e.value,
      at: e.at,
    }))
    return track(deps.meterSink.emit(records).catch(() => undefined).then(() => undefined))
  }

  // Build the capability surface handed to a breed's `handle` hook.
  function buildIo(scope: Scope): BreedIO {
    const { resolvedKey, paddock } = scope
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
        return rawToUpstream(paddock.flock, path, init, { fetchImpl: deps.fetchImpl })
      },
      emitMeter: (events) => emitScoped(scope, events),
      jobs: deps.jobStore,
    }
  }

  return {
    async paddockScope(resolvedKey, slug) {
      const paddock = await deps.configStore.getPaddockBySlug(slug)
      if (!paddock || paddock.status !== 'active') return { ok: false, refusal: { status: 404, body: { error: 'unknown paddock' } } }
      if (!resolvedKey.paddockSlugs.includes(slug)) {
        return { ok: false, refusal: { status: 403, body: { error: 'key not scoped to paddock' } } }
      }
      // Fail closed, and only now: behind the key and scope gates, so only a caller entitled to this
      // paddock learns its credential is broken. Forwarding without it would turn a key problem into
      // an upstream 401 that points everyone at the wrong system.
      if (paddock.upstreamAuthError) {
        return { ok: false, refusal: { status: 503, body: { error: 'upstream credential unavailable' } } }
      }
      return { ok: true, scope: { resolvedKey, paddock, breed: deps.registry.get(paddock.breedId) } }
    },

    async limits({ resolvedKey, paddock }) {
      const limit = resolvedKey.overrides?.rateLimit ?? paddock.fence.rateLimit ?? defaultLimit
      const rl = await deps.rateLimiter.check(`${resolvedKey.keyId}:${paddock.paddockId}`, limit)
      if (!rl.allowed) {
        return { status: 429, body: { error: 'rate limit exceeded' }, headers: { 'retry-after': String(rl.retryAfterSec) } }
      }

      // Quota caps (hard). Read the current period's rollup total per rule and
      // reject at/over the cap. Enforced against already-aggregated usage, so a
      // single in-flight request may cross the cap before it is counted
      // (bounded by worker lag) — acceptable for v1; see Plan 4 carry-forward.
      if (deps.usageReader && paddock.fence.quota != null) {
        const parsed = quotaSchema.safeParse(paddock.fence.quota)
        // Fail-open by design: a malformed quota disables the cap for this request rather than
        // 500ing it — a misconfigured fence must not take the data plane down.
        if (parsed.success) {
          const now = Date.now()
          for (const rule of parsed.data) {
            const used = await deps.usageReader.periodUsage(resolvedKey.keyId, paddock.paddockId, rule.dim, rule.period, now)
            if (used >= rule.max) return { status: 429, body: { error: 'quota exceeded', dim: rule.dim } }
          }
        }
      }
      return null
    },

    async run(scope, ctx) {
      const { paddock, breed } = scope
      const fence = breed.constraintSchema.parse(paddock.fence.constraintJson)

      // Breeds that own a multi-step flow implement `handle`. Delegate the
      // entire request to it — EXCEPT a request that targets one of the breed's
      // declared direct upstream routes (all exposeByDefault:false). Those are
      // bypass attempts and must be denied by `guard` (defense in depth), so a
      // consumer can never reach a raw upstream endpoint (e.g. /prompt) directly.
      if (breed.handle) {
        const direct = breed.routes.find(
          (r) => r.method === ctx.method && !r.exposeByDefault && (ctx.path === r.path || ctx.path.startsWith(r.path + '/')),
        )
        if (direct) {
          const guard = await breed.guard(ctx, fence)
          if (!guard.ok) return { kind: 'refused', refusal: { status: guard.status, body: { error: guard.reason } } }
        }
        const result = await breed.handle(ctx, fence, buildIo(scope))
        return { kind: 'handled', status: result.status, body: result.body }
      }

      // Generic path (Ollama): guard → proxy → meter.
      const guard = await breed.guard(ctx, fence)
      if (!guard.ok) return { kind: 'refused', refusal: { status: guard.status, body: { error: guard.reason } } }

      const { response, metering } = await proxyToUpstream(paddock.flock, guard.request, { fetchImpl: deps.fetchImpl })
      track(metering.then((upstream) => emitScoped(scope, breed.meter(ctx, upstream))).catch(() => undefined).then(() => undefined))
      return { kind: 'proxied', response, metering }
    },

    // Consumers poll their own job by id and receive a scoped `{ done, images }` view — never the raw
    // /history payload or a direct /view URL. A job belonging to another key returns 404 (not 403) so
    // it does not leak the existence of other keys' jobs.
    async jobResult(scope, jobId) {
      const { resolvedKey, paddock } = scope
      const job = await deps.jobStore.get(jobId)
      if (!job || job.keyId !== resolvedKey.keyId || job.paddockId !== paddock.paddockId) {
        return { status: 404, body: { error: 'not found' } }
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
      if (outcome.done && (await deps.jobStore.markMetered(jobId))) {
        const at = Date.now()
        await emitScoped(scope, [
          { dim: 'images', value: outcome.images.length, at },
          { dim: 'gpu_ms', value: outcome.gpuMs, at },
        ])
      }
      return { status: 200, body: { done: outcome.done, images: outcome.images } }
    },

    raw(scope, path, init) {
      return rawToUpstream(scope.paddock.flock, path, init, { fetchImpl: deps.fetchImpl })
    },

    async drain() {
      await Promise.all([...pending])
    },
  }
}
