/**
 * Content-Security-Policy for the operator console.
 *
 * Nonce-based rather than allowlist-based: Next injects its own inline bootstrap and
 * RSC-payload `<script>` tags on every HTML response, so `script-src 'self'` alone would
 * break the app and `'unsafe-inline'` would make the header decorative. Middleware mints a
 * fresh nonce per request; Next stamps it onto the scripts it emits, and `'strict-dynamic'`
 * extends that trust to the chunks the bootstrap then loads.
 *
 * Kept as a pure string builder (no crypto, no request object) so the policy itself is
 * unit-testable — the nonce is supplied by the caller.
 */

export interface CspOptions {
  /** Dev server: webpack HMR needs eval + a websocket back to the dev server. */
  dev: boolean
}

/**
 * HSTS. Two years, scoped to the exact host.
 *
 * Deliberately no `includeSubDomains` and no `preload`: MetaModels is self-hosted, so the
 * console may share an apex domain with services its operator serves over plain HTTP, and
 * `preload` is effectively irreversible. Operators terminating TLS for a whole domain they
 * control should add both — see docs/DEPLOY.md.
 */
export const HSTS_VALUE = 'max-age=63072000'

export function buildCsp(nonce: string, { dev }: CspOptions): string {
  const scriptSrc = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"]
  const connectSrc = ["'self'"]

  if (dev) {
    // webpack's dev runtime evaluates module code, and HMR opens a websocket.
    scriptSrc.push("'unsafe-eval'")
    connectSrc.push('ws:')
  }

  const directives: Array<[string, string[]]> = [
    ['default-src', ["'self'"]],
    ['script-src', scriptSrc],
    // Next inlines the `<style>` for next/font and for critical CSS; those tags are not
    // nonce-stamped, so inline styles must be permitted. Far weaker sink than script — an
    // injected <style> cannot execute, and `default-src 'self'` still bounds every load.
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'blob:']],
    // next/font/google downloads and self-hosts at build time: no external font origin.
    ['font-src', ["'self'"]],
    ['connect-src', connectSrc],
    ['worker-src', ["'self'", 'blob:']],
    ['object-src', ["'none'"]],
    ['frame-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
  ]

  // No `upgrade-insecure-requests`: self-hosted deployments legitimately run on plain HTTP
  // over a LAN, where upgrading same-origin subresources to https would break every asset.
  return directives.map(([name, values]) => `${name} ${values.join(' ')}`).join('; ')
}
