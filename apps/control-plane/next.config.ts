import type { NextConfig } from 'next'

// Static headers only. Content-Security-Policy is set per-request in src/middleware.ts
// because it carries a fresh nonce on every response.
//
// The HSTS value is duplicated from src/lib/csp.ts rather than imported: Next compiles
// next.config.ts in isolation and externalises its imports, so it cannot pull from src/.
// src/lib/security-headers.test.ts asserts the two stay identical.
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  // Inert over plain HTTP, so this is safe for LAN deployments and takes effect the moment
  // an operator puts the console behind TLS.
  { key: 'Strict-Transport-Security', value: 'max-age=63072000' },
]

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages ship TypeScript source and are consumed directly. Next must
  // transpile them rather than treat the symlinked packages as pre-built externals.
  transpilePackages: ['@metamodels/schema', '@metamodels/connectors'],
  // Those packages are `composite` tsc builds emitting to `dist`, so their barrels
  // use required NodeNext-style `.js` specifiers (e.g. `export * from './schema.js'`)
  // that point at `.ts` source. tsc (moduleResolution: Bundler) tolerates this, but
  // Next's bundler needs to be told to resolve a `.js` request to the `.ts` file.
  experimental: {
    extensionAlias: { '.js': ['.ts', '.tsx', '.js', '.jsx'] },
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
}

export default nextConfig
