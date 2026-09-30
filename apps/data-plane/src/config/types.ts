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
  /** For an oauth key (M4 D1): the CIMD `client_id` it was approved for. Absent for a live key. */
  oauthClientId?: string
}

export interface ResolvedPaddock {
  paddockId: string
  orgId: string
  slug: string
  /** The display name: the MCP `serverInfo.title`. */
  name: string
  status: string
  breedId: string
  /** `upstreamAuth` is the OPENED credential, plaintext — held in memory only, never stored as such. */
  flock: { baseUrl: string; upstreamAuth: string | null; tlsTrust: boolean }
  fence: { constraintJson: unknown; rateLimit: RateLimit | null; quota: unknown }
  /** Set when the flock has a credential that no held key opens; the paddock must then fail closed. */
  upstreamAuthError?: UnsealReason
}
