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
}

export function defineBreed<C>(breed: Breed<C>): Breed<C> {
  return breed
}
