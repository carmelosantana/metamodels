import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'],
    environment: 'node',
    // Covers only the root lane: the test dirs of apps/auth, apps/data-plane, apps/migrate,
    // apps/worker and packages/*. (Control-plane tests live in src/**/*.test.ts under that app's
    // own config, run with --testTimeout=30000 in CI, and never match these globs.) Suites here
    // spin up PGlite and run real scrypt, which can exceed vitest's 5s default on a loaded
    // machine. The tradeoff: a hung test now takes 30s, not 5s, to fail.
    testTimeout: 30000,
  },
})
