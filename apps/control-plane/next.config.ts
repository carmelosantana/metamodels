import type { NextConfig } from 'next'

const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
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
