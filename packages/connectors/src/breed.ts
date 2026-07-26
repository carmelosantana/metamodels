import type { ZodTypeAny } from 'zod'
import type { MeterDim, RouteClass } from '@metamodels/schema'

export interface RouteSpec {
  method: string
  path: string
  class: RouteClass
  exposeByDefault: boolean
}

export interface RequestCtx {
  method: string
  path: string
  headers: Record<string, string>
  body: unknown
  paddockSlug: string
}

export interface RewrittenRequest {
  method: string
  path: string
  headers: Record<string, string>
  body: unknown
}

export type GuardResult =
  | { ok: true; request: RewrittenRequest }
  | { ok: false; status: 401 | 403 | 422; reason: string }

export interface MeterEvent {
  dim: MeterDim
  value: number
  at: number
}

export interface HealthStatus {
  ok: boolean
  detail?: string
}

export interface UpstreamResult {
  status: number
  headers: Record<string, string>
  body: unknown
  finalFrame?: unknown
}

export interface FlockRef {
  baseUrl: string
  upstreamAuth?: string | null
  tlsTrust?: boolean
}

export interface JobRecord {
  jobId: string
  keyId: string
  paddockId: string
  orgId: string
  templateId: string
  cost: number
  metered: boolean
  submittedAt: number
}

export interface JobStore {
  create(job: Omit<JobRecord, 'metered'>): Promise<JobRecord>
  get(jobId: string): Promise<JobRecord | null>
  /**
   * Compare-and-set the `metered` flag. Returns `true` IFF this call
   * transitioned the job from not-metered → metered; `false` if the job was
   * already metered or is unknown. Callers meter side effects only on `true`,
   * which makes concurrent result polls safe (exactly one wins).
   */
  markMetered(jobId: string): Promise<boolean>
}

export interface BreedIO {
  ids: { orgId: string; keyId: string; paddockId: string }
  flock: FlockRef
  upstream(req: RewrittenRequest): Promise<UpstreamResult>
  upstreamRaw(path: string, init: RequestInit): Promise<Response>
  emitMeter(events: MeterEvent[]): Promise<void>
  jobs: JobStore
}

export interface BreedHandleResult {
  status: number
  body: unknown
}

export interface Breed<C = unknown> {
  id: string
  displayName: string
  routes: RouteSpec[]
  constraintSchema: ZodTypeAny
  health(flock: FlockRef): Promise<HealthStatus>
  guard(ctx: RequestCtx, fence: C): GuardResult | Promise<GuardResult>
  meter(ctx: RequestCtx, upstream: UpstreamResult): MeterEvent[]
  billingDimensions: MeterDim[]
  toMcp?(fence: C): unknown[]
  handle?(ctx: RequestCtx, fence: C, io: BreedIO): Promise<BreedHandleResult>
}

export function defineBreed<C>(breed: Breed<C>): Breed<C> {
  return breed
}
