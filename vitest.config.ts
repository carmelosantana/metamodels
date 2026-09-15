import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'],
    environment: 'node',
    // The auth and control-plane suites each spin up PGlite and run real scrypt, which exceeds
    // vitest's 5s default on a loaded machine. CI already passes --testTimeout=30000 for the
    // control-plane lane; this makes the root lane match.
    testTimeout: 30000,
  },
})
