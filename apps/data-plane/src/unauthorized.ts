/**
 * Every 401 the proxy emits is built here, so neither rule below can be lost one route at a time.
 *
 * **The challenge is mandatory.** RFC 9110 §15.5.2 makes `WWW-Authenticate` a MUST on any 401,
 * independent of the auth scheme — an HTTP conformance rule, not an OAuth nicety. All three of
 * this surface's 401s shipped without it.
 *
 * **A presented key gets one body, whatever the reason.** `'invalid api key'` versus
 * `'expired api key'` told a caller whether the key it presented had ever existed and whether it
 * had merely lapsed. Against consumer `mm_live_` keys that is an enumeration oracle: it turns a
 * blind guess into a graded signal. The control plane's admin API closes the same shape of hole
 * with one fixed, reason-independent `detail` for every rejected token
 * (`apps/control-plane/src/server/problem.ts`).
 *
 * A request carrying **no** key stays distinguishable, deliberately. It reports the caller's own
 * request shape, not server-side state about any key, so it grades nothing — and RFC 6750 §3.1
 * says a request with no credentials SHOULD NOT be told an error code at all. It is also the one
 * 401 a misconfigured client can act on.
 */

/**
 * `extractKey` reads `Authorization: Bearer <key>`, so `Bearer` is the scheme to advertise. The
 * `X-API-Key` fallback is a bare header, not an HTTP authentication scheme, and RFC 9110 §11.6.1
 * gives a challenge no way to name one — so it is unadvertisable here rather than omitted.
 *
 * The bare scheme and nothing else. RFC 6750 §3 would permit `error="invalid_token"` versus
 * `error="invalid_request"`, but that would restate in a header precisely the distinction the
 * bodies below refuse to make, reopening the oracle from the other side.
 */
export const API_KEY_CHALLENGE = 'Bearer'

/**
 * Why a key was refused, in the server's own terms. Never echoed to the caller: these strings
 * exist to be logged, and the two `presented`-key arms collapse to one body on the way out.
 */
export type KeyRejection =
  | 'no key presented'
  | 'no key matches the presented hash'
  | 'the presented key has expired'

/** The one body every refused *presented* key gets. Wording unchanged from the `invalid` arm. */
const PRESENTED_KEY_REFUSED = 'invalid api key'
const NO_KEY_PRESENTED = 'missing api key'

export function unauthorizedKey(rejection: KeyRejection): Response {
  const presented = rejection !== 'no key presented'
  // Where the distinction the body drops actually goes. The admin API keeps the equivalent on a
  // `TokenError`'s `reason`/`cause`; this surface has no error to carry it, so it logs directly.
  // One line per rejected credential — proportional to the attempts an attacker already makes,
  // and the only place an operator can still tell an expired key from an unknown one.
  if (presented) console.warn(`[auth] 401 on /p: ${rejection}`)
  return new Response(JSON.stringify({ error: presented ? PRESENTED_KEY_REFUSED : NO_KEY_PRESENTED }), {
    status: 401,
    headers: { 'content-type': 'application/json', 'www-authenticate': API_KEY_CHALLENGE },
  })
}
