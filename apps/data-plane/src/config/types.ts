export interface RateLimit {
  windowSec: number
  max: number
}

export interface KeyOverrides {
  rateLimit?: RateLimit
}

export interface ResolvedKey {
  keyId: string
  orgId: string
  status: string
  expiresAt: Date | null
  paddockSlugs: string[]
  overrides: KeyOverrides | null
}

export interface ResolvedPaddock {
  paddockId: string
  orgId: string
  slug: string
  status: string
  breedId: string
  flock: { baseUrl: string; upstreamAuth: string | null; tlsTrust: boolean }
  fence: { constraintJson: unknown; rateLimit: RateLimit | null; quota: unknown }
}
