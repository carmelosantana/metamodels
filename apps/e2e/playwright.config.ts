import { defineConfig, devices } from '@playwright/test'
import { CONTROL_PLANE_URL } from './specs/helpers/env.js'

/**
 * The acceptance walkthrough drives a stack that is already running — it does not start
 * one. Bring it up with `docker compose up -d` first; see apps/e2e/README.md.
 *
 * Specs live in `specs/` and are named `*.spec.ts` on purpose. The root vitest lane globs
 * `apps/**‍/test/**‍/*.test.ts`, so a Playwright spec under a `test/` directory would be
 * collected by vitest as well and fail there.
 */
export default defineConfig({
  testDir: './specs',
  // The walkthrough is one ordered story against shared server state: log in, create a
  // flock, publish a paddock, mint a key. Running it in parallel would be incoherent.
  fullyParallel: false,
  workers: 1,
  // A real upstream model is involved; generation dominates the budget.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  // Fail the run rather than silently pass if someone leaves a .only behind.
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: CONTROL_PLANE_URL,
    // Fixed viewport: the screenshots are committed documentation, so they must not
    // change size from one machine to the next.
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
