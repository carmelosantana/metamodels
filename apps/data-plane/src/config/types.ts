import type { UnsealReason } from '@metamodels/schema/sealed'
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
  /** `upstreamAuth` is the OPENED credential, plaintext — held in memory only, never stored as such. */
  flock: { baseUrl: string; upstreamAuth: string | null; tlsTrust: boolean }
  fence: { constraintJson: unknown; rateLimit: RateLimit | null; quota: unknown }
  /** Set when the flock has a credential that no held key opens; the paddock must then fail closed. */
  upstreamAuthError?: UnsealReason
}
