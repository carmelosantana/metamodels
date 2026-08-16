import { NextResponse, type NextRequest } from 'next/server'
import { buildCsp } from './lib/csp.js'

/**
 * Mints a per-request CSP nonce and attaches the policy to both the request (so Next stamps
 * the nonce onto the `<script>` tags it emits) and the response (so the browser enforces it).
 *
 * Static assets are excluded below — they are not HTML, carry no nonce, and are served
 * straight from the filesystem, so running this on them is pure overhead.
 */
export function middleware(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID())
  const csp = buildCsp(nonce, { dev: process.env.NODE_ENV !== 'production' })

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  // Next reads the CSP off the *request* headers to find the nonce to stamp onto its scripts.
  requestHeaders.set('Content-Security-Policy', csp)

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set('Content-Security-Policy', csp)
  return response
}

export const config = {
  matcher: [
    /*
     * Every path except build output and the favicon — those are static files with no
     * inline script to protect. Prefetches are skipped too: their RSC payloads are cached
     * by the router, so stamping a single-use nonce into a reusable response is both
     * pointless and a way to serve a stale nonce later.
     */
    {
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
}
