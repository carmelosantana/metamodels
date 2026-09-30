import { createPrivateKey, randomUUID } from 'node:crypto'
import type { JWK } from 'oidc-provider'
import { CONSENT_ASSERTION_TYP, internalApiAudience } from '@metamodels/schema'
import { signJwtRs256 } from '@metamodels/schema/jws'

/** Half the 60 s the control plane accepts: room for clock skew between the two services. */
export const CONSENT_ASSERTION_TTL_S = 30
const CALL_TIMEOUT_MS = 5_000

export const PREFLIGHT_UNAVAILABLE = 'MetaModels could not check this approval right now. Try again in a moment.'
export const MINT_DENIED_ROLE = 'Your role cannot approve apps.'
// Retyped across the service boundary: its twin is PREFLIGHT_NO_PADDOCK in control-plane keys-service.ts.
export const MINT_DENIED_PADDOCK = 'This paddock does not exist, is disabled, or is not in your organization.'

/** What the OP asserts: this user approved this client for this resource (and, on a mint, under this grant). */
export interface ConsentRequest {
  accountId: string
  clientId: string
  clientName: string
  resource: string
}

export type Preflight = { allowed: true } | { allowed: false; reason: string }

export type MintOutcome =
  | { ok: true; keyId: string }
  | { ok: false; kind: 'denied'; reason: string }
  | { ok: false; kind: 'error'; detail: string }

/** The control plane, as the consent screen sees it. Injectable so tests need no control plane. */
export interface ConsentApi {
  preflight(r: ConsentRequest): Promise<Preflight>
  mint(r: ConsentRequest & { grantId: string }): Promise<MintOutcome>
}

/**
 * Signs the consent assertion with the OP's current signing key — `signingJwks(…).keys[0]`, the key
 * oidc-provider itself signs with — so the control plane verifies it against the JWKS it already
 * trusts. `typ` and `aud` are fixed; the `jti` is fresh for every call and refused on replay.
 */
export function consentAsserter(opts: { issuer: string; consoleUrl: string; signingJwk: JWK }) {
  const { kid, alg: _alg, use: _use, ...material } = opts.signingJwk as JWK & Record<string, unknown>
  const key = createPrivateKey({ key: material as JsonWebKey, format: 'jwk' })
  const aud = internalApiAudience(opts.consoleUrl)
  return (r: ConsentRequest & { grantId?: string }): string => {
    const now = Math.floor(Date.now() / 1000)
    return signJwtRs256({ typ: CONSENT_ASSERTION_TYP, kid }, {
      iss: opts.issuer,
      aud,
      iat: now,
      exp: now + CONSENT_ASSERTION_TTL_S,
      jti: randomUUID(),
      sub: r.accountId,
      client_id: r.clientId,
      client_name: r.clientName,
      resource: r.resource,
      ...(r.grantId ? { grant_id: r.grantId } : {}),
    }, key)
  }
}

/** The control plane's `/api/internal/v1/oauth-keys` routes (Task 4), over `CONTROL_PLANE_INTERNAL_URL`. */
export function httpConsentApi(opts: {
  baseUrl: string
  assert: (r: ConsentRequest & { grantId?: string }) => string
  fetchImpl?: typeof fetch
}): ConsentApi {
  const doFetch = opts.fetchImpl ?? fetch
  const url = (suffix: string) => `${opts.baseUrl}/api/internal/v1/oauth-keys${suffix}`
  return {
    async preflight(r) {
      try {
        const res = await doFetch(url('/preflight'), {
          headers: { authorization: `Bearer ${opts.assert(r)}` },
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        })
        if (res.status !== 200) return { allowed: false, reason: PREFLIGHT_UNAVAILABLE }
        const body = (await res.json()) as { allowed?: unknown; reason?: unknown }
        if (body.allowed === true) return { allowed: true }
        return { allowed: false, reason: typeof body.reason === 'string' && body.reason ? body.reason : PREFLIGHT_UNAVAILABLE }
      } catch {
        return { allowed: false, reason: PREFLIGHT_UNAVAILABLE }
      }
    },
    async mint(r) {
      let res: Response
      try {
        res = await doFetch(url(''), {
          method: 'POST',
          headers: { authorization: `Bearer ${opts.assert(r)}` },
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        })
      } catch (e) {
        return { ok: false, kind: 'error', detail: `the control plane could not be reached: ${String(e)}` }
      }
      if (res.status === 200) {
        const body = (await res.json().catch(() => null)) as { key_id?: unknown } | null
        return typeof body?.key_id === 'string'
          ? { ok: true, keyId: body.key_id }
          : { ok: false, kind: 'error', detail: 'the control plane answered 200 with no key_id' }
      }
      // A refusal after a preflight said yes: the user's role or the paddock changed in between.
      if (res.status === 403) return { ok: false, kind: 'denied', reason: MINT_DENIED_ROLE }
      if (res.status === 404) return { ok: false, kind: 'denied', reason: MINT_DENIED_PADDOCK }
      return { ok: false, kind: 'error', detail: `the control plane answered ${res.status}` }
    },
  }
}
