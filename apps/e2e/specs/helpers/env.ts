/**
 * Every knob the acceptance walkthrough reads, in one place.
 *
 * `OLLAMA_TEST_URL` is the gate: unset means "no real upstream available", and the suite
 * skips rather than fails. Same opt-in convention as the PG_TEST_URL / REDIS_TEST_URL
 * integration suites elsewhere in this repo.
 */

/** Control-plane (operator console). Defaults to the port docker-compose publishes. */
export const CONTROL_PLANE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000'

/** Data-plane (the governed proxy consumers actually call). */
export const PROXY_URL = process.env.E2E_PROXY_URL ?? 'http://localhost:8787'

/**
 * Upstream Ollama, as reachable **from inside the data-plane container** — not from your
 * shell. A LAN address works; `localhost` would resolve to the container itself.
 */
export const OLLAMA_URL = process.env.OLLAMA_TEST_URL

/** A small model keeps the walkthrough fast. Must exist on the upstream server. */
export const OLLAMA_MODEL = process.env.OLLAMA_TEST_MODEL ?? 'qwen2.5-coder:0.5b'

/** Seeded operator, per .env.example. */
export const OPERATOR_EMAIL = process.env.OPERATOR_EMAIL ?? 'admin@example.com'
export const OPERATOR_PASSWORD = process.env.OPERATOR_PASSWORD ?? 'change-me'

/** Where the committed documentation screenshots are written. */
export const SCREENSHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? '../../docs/screenshots'

/**
 * Distinguishes this run's fixtures from anything already in the database. The operator
 * console is a real environment with real data in it; the walkthrough must never collide
 * with, or clean up, a flock or paddock a human created.
 */
export const RUN_ID = Math.random().toString(36).slice(2, 8)

export const skipReason = OLLAMA_URL
  ? null
  : 'OLLAMA_TEST_URL is not set — no upstream to run the acceptance walkthrough against'
