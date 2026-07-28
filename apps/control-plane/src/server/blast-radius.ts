import type { QuotaRuleInput, RateLimitInput } from '../lib/fence-schema'

export interface BlastRadius {
  breedId: string
  mutateLocked: true
  exposed: string[]
  models: 'any' | string[]
  templateCount: number | null
  rateLimit: RateLimitInput | null
  quota: QuotaRuleInput[]
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

export function computeBlastRadius(
  breedId: string,
  constraintJson: unknown,
  rateLimit: unknown,
  quota: unknown,
): BlastRadius {
  const c = asRecord(constraintJson)
  const rl = asRecord(rateLimit)
  const hasRate = typeof rl.windowSec === 'number' && typeof rl.max === 'number'

  let exposed: string[] = []
  let models: 'any' | string[] = 'any'
  let templateCount: number | null = null

  if (breedId === 'comfyui') {
    const templates = Array.isArray(c.templates) ? c.templates : []
    exposed = templates.map((t) => String(asRecord(t).id ?? '')).filter(Boolean)
    templateCount = templates.length
  } else {
    exposed = Array.isArray(c.allowedRoutes) ? c.allowedRoutes.map(String) : []
    models = Array.isArray(c.allowedModels) ? c.allowedModels.map(String) : 'any'
  }

  return {
    breedId,
    mutateLocked: true,
    exposed,
    models,
    templateCount,
    rateLimit: hasRate ? { windowSec: rl.windowSec as number, max: rl.max as number } : null,
    quota: Array.isArray(quota) ? (quota as QuotaRuleInput[]) : [],
  }
}
