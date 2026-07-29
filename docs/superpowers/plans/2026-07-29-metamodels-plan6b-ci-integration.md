# MetaModels Plan 6b — CI Hardening + Real-Redis/Postgres Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the CI pipeline and the real-server integration tests that Plan 6a's packaging enables — a per-org-lock Postgres concurrency test, a config-invalidation pub/sub smoke on real Redis, and a hardened GitHub Actions workflow that runs both test lanes (with the `skipIf` integration tests now executing against service-container Postgres+Redis), typechecks, and builds+smokes the Docker stack.

**Architecture:** Three new **integration tests** gated by `PG_TEST_URL` / `REDIS_TEST_URL` (mirroring the existing worker `skipIf(!REDIS_TEST_URL)` convention) prove the two seams pglite/ioredis-mock structurally cannot — real multi-connection `SELECT … FOR UPDATE` serialization, and real cross-connection Redis pub/sub. A GitHub Actions `ci.yml` declares `postgres:16` + `redis:7` **service containers**, sets those env vars so the `skipIf` tests run in CI, builds the control-plane before typechecking (the `.next/types` gotcha), and runs a Docker build + `scripts/smoke.sh` acceptance job. A separate `zizmor` workflow + `CODEOWNERS` enforce the supply-chain rules.

**Tech Stack:** GitHub Actions (service containers) · Vitest + real `postgres`(-js) + real `ioredis` · Node 24 / corepack pnpm 11.9.0 · Docker (build + smoke, on the runner) · zizmor (workflow static analysis).

## Global Constraints

- **Node `>=24`; ESM only.** CI uses `node-version-file: .nvmrc` (`.nvmrc` = `24`). pnpm is `11.9.0` via `corepack prepare pnpm@11.9.0 --activate` (no `packageManager` field; pin explicitly). Install with `pnpm install --frozen-lockfile`.
- **Integration tests are opt-in via env, and SKIP cleanly when unset** — exactly like the existing `apps/worker/test/worker.test.ts` (`describe.skipIf(!process.env.REDIS_TEST_URL)`). New env vars: **`PG_TEST_URL`** (a real multi-connection Postgres — pglite is single-connection and *cannot* prove `FOR UPDATE` serialization) and the already-used **`REDIS_TEST_URL`**. Never point these at a production server. They are **excluded from `.env.example`** and from the Plan-6a env-drift guard's required set (that guard already excludes `REDIS_TEST_URL`; add `PG_TEST_URL` to its `EXCLUDED` set — see Task 1).
- **Do NOT mock to fake coverage.** The whole point of these tests is real servers. No `ioredis-mock`, no pglite, no fake `FOR UPDATE`. If a real server is unavailable the test SKIPS; it never passes by mocking the thing under test.
- **Determinism unaffected.** Services still take injected `nowMs`; tests may use `Date.now()`/`crypto.randomUUID()` in the *test* layer only (never inside a service).
- **`Db = PgDatabase<any, any, any>`** (`apps/control-plane/src/server/db.ts`) — a real `drizzle(postgres(url), { schema })` handle satisfies the same `Db` type the services take, so the concurrency test drops straight into `inviteUser`/`setUserStatus` with no signature change.
- **Test lanes & where each test runs (vitest globs):** root `pnpm test` globs `packages/**/test/**` + `apps/**/test/**/*.test.ts`; control-plane `pnpm --filter @metamodels/control-plane exec vitest run` globs `src/**/*.test.ts`. So a file in `apps/control-plane/src/server/*.test.ts` runs in the **control-plane lane only**; a file in `apps/data-plane/test/*.test.ts` runs in the **root lane only**. Place each new test accordingly so it is never double-collected. Baselines to keep green: **root 192 pass / 3 skip**, **control-plane 167 pass**, `pnpm -w exec tsc -b` clean. (Two pre-existing scrypt tests can time out under CPU contention — re-run the control-plane lane with `--testTimeout=30000`.)
- **When `PG_TEST_URL`/`REDIS_TEST_URL` ARE set, the skip counts become runs:** the 3 pre-existing worker skips (root) execute, the new concurrency tests (control-plane) execute, the new pub/sub test (root) executes. Record both the unset (skipped) and set (run) counts.
- **GitHub Actions supply-chain rules (from the `supply-chain-risk-mitigation` skill / roadmap §"Supply-chain / CI hardening"):** every third-party action **pinned to a full 40-char commit SHA** (never a tag/branch), with a `# vX.Y.Z` trailing comment; **no `pull_request_target`** checking out/running fork code; least-privilege `permissions:` (default `contents: read`, elevate per-job only as needed); `pnpm install --frozen-lockfile`; no `id-token: write` (no publishing in this plan); if any cache action is used it must be `actions/cache/restore` (restore-only, no auto-save) — this plan skips dependency caching entirely to minimize attack surface. `zizmor` runs as a required workflow check and will FAIL the build on any unpinned action or known misconfiguration — so the SHA-pin is machine-enforced, not just convention.
- **CI executes only on GitHub.** There is **no git remote yet**, and `actionlint`/`zizmor`/`act` are **not installed locally**, so the `.github/workflows/*.yml` files can be authored and structurally reviewed here but their **first real run happens when the branch is pushed to a GitHub remote**. The implementer MUST NOT claim a CI run passed that did not happen (same honesty rule as Plan 6a's Docker-daemon steps). Static local validation = careful structural review + the grep-based pin/`pull_request_target` gates in Task 5.
- **The integration TESTS, by contrast, run locally now** — a Docker daemon is available, so each test task provisions a throwaway `postgres:16-bookworm` + `redis:7-bookworm` container, sets `PG_TEST_URL`/`REDIS_TEST_URL`, runs the test GREEN for real, then removes the container. This is required verification, not deferred.
- **No new runtime dependency.** `postgres` (^3.4.0) is already a control-plane dep; `ioredis` (5.4.2) is already a data-plane dep; both `@electric-sql/pglite` and `drizzle-orm` are present. Tasks add only test files, workflow YAML, `CODEOWNERS`, and docs — no `package.json` dependency additions.
- **Git identity:** `Carmelo Santana <me@carmelosantana.com>`. Branch: `feat/metamodels-plan6b` off `main` `fa8069b`.

---

## File Structure

```
apps/control-plane/src/test/real-pg.ts                       # CREATE: real-Postgres test harness (makeRealPgDb) — PG_TEST_URL
apps/control-plane/src/test/real-pg.test.ts                  # CREATE: harness round-trip (control-plane lane, skipIf(!PG_TEST_URL))
apps/control-plane/src/server/org-lock-concurrency.test.ts   # CREATE: seat race + last-admin race (control-plane lane, skipIf(!PG_TEST_URL))
apps/data-plane/test/config-pubsub.integration.test.ts       # CREATE: real-Redis pub/sub → CachingConfigStore flush (root lane, skipIf(!REDIS_TEST_URL))
packages/schema/test/env-example.test.ts                     # MODIFY: add PG_TEST_URL to EXCLUDED
.github/workflows/ci.yml                                     # CREATE: install → build → typecheck → both lanes (PG+Redis services) → docker build+smoke
.github/workflows/zizmor.yml                                 # CREATE: zizmor static analysis of the workflows (required check)
.github/CODEOWNERS                                           # CREATE: own .github/ (+ root) so workflow changes need review
docs/DEPLOY.md                                               # MODIFY: "Running the integration tests" section (PG_TEST_URL/REDIS_TEST_URL)
```

**Decisions already made (surfaced to Carmelo, applied here):**
1. **Real servers via GitHub Actions `services:` containers** (not testcontainers, not booting the 6a compose) — no new dep, matches the existing `skipIf` convention; locally the same env vars point at throwaway/compose containers.
2. **CI includes a Docker build + `scripts/smoke.sh` job** — the strongest v1 acceptance gate.
3. **`PG_TEST_URL`** gates the concurrency test, mirroring `REDIS_TEST_URL` — explicit opt-in, never collides with the app's `DATABASE_URL`.

---

### Task 1: Real-Postgres test harness (`PG_TEST_URL`) + round-trip

A tiny reusable helper that builds a real `postgres`-js drizzle handle against `PG_TEST_URL`, runs the frozen migrations once, and closes cleanly — plus a round-trip test proving the harness and confirming it SKIPS when the env var is unset. This is the foundation Task 2 builds on. Also teach the Plan-6a env-drift guard that `PG_TEST_URL` is test-only.

**Files:**
- Create: `apps/control-plane/src/test/real-pg.ts`
- Create: `apps/control-plane/src/test/real-pg.test.ts` (control-plane lane — `src/**/*.test.ts`)
- Modify: `packages/schema/test/env-example.test.ts` (add `PG_TEST_URL` to `EXCLUDED`)

**Interfaces:**
- Produces:
  - `PG_TEST_URL: string | undefined` — re-export of `process.env.PG_TEST_URL` (single source for the skip guard).
  - `makeRealPgDb(): Promise<{ db: Db; close: () => Promise<void> }>` — opens a `postgres(PG_TEST_URL!, { max: 8 })` client (multi-connection so `FOR UPDATE` can actually block a second connection), wraps it with `drizzle(client, { schema })`, runs `migrate(db, { migrationsFolder })` against the frozen `packages/schema/drizzle`, and returns the handle plus a `close()` that ends the client. `max: 8` is deliberate — a single-connection pool would make two "concurrent" transactions run serially at the driver level and mask a missing lock.
  - `uniqueEmail(prefix?: string): string` / `uniqueName(prefix?: string): string` — `${prefix}-${randomUUID()}@example.com` etc., so tests never collide across runs on a persistent DB.

- [ ] **Step 1: Write the harness**

Create `apps/control-plane/src/test/real-pg.ts`:
```ts
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import * as schema from '@metamodels/schema'
import type { Db } from '../server/db'

/** Set to a REAL multi-connection Postgres to run the integration tests; unset → they skip.
 *  pglite is single-connection and cannot prove SELECT … FOR UPDATE serialization. */
export const PG_TEST_URL = process.env.PG_TEST_URL

const migrationsFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/schema/drizzle',
)

/** Open a real postgres-js drizzle handle (multi-connection) and apply the frozen migrations.
 *  `max: 8` lets two transactions run on distinct connections so a FOR UPDATE lock can actually block. */
export async function makeRealPgDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const client = postgres(PG_TEST_URL!, { max: 8 })
  const db = drizzle(client, { schema }) as unknown as Db
  await migrate(db as never, { migrationsFolder })
  return { db, close: () => client.end() }
}

export function uniqueEmail(prefix = 'u'): string {
  return `${prefix}-${randomUUID()}@example.com`
}

export function uniqueName(prefix = 'o'): string {
  return `${prefix}-${randomUUID()}`
}
```

- [ ] **Step 2: Write the failing round-trip test**

Create `apps/control-plane/src/test/real-pg.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import { org } from '@metamodels/schema'
import { PG_TEST_URL, makeRealPgDb, uniqueName, type } from './real-pg'
import type { Db } from '../server/db'

describe.skipIf(!PG_TEST_URL)('real-pg harness', () => {
  let db: Db
  let close: () => Promise<void>
  beforeAll(async () => {
    ;({ db, close } = await makeRealPgDb())
  })
  afterAll(async () => {
    await close()
  })

  test('migrates and round-trips an org on a real Postgres', async () => {
    const name = uniqueName()
    const [row] = await db.insert(org).values({ name }).returning()
    const [read] = await db.select().from(org).where(eq(org.id, row.id))
    expect(read.name).toBe(name)
  })
})
```
(Note: the `type` import above is a deliberate typo placeholder to force a RED first run — remove it in Step 3. See Step 2b.)

- [ ] **Step 2b: Run it — expect fail**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/test/real-pg.test.ts`
Expected: FAIL — the bogus `type` import from `./real-pg` does not exist (compile error). This proves the test is really executing the file, not silently skipped-as-passed.

- [ ] **Step 3: Fix the import**

Edit `apps/control-plane/src/test/real-pg.test.ts` — change the import line to:
```ts
import { PG_TEST_URL, makeRealPgDb, uniqueName } from './real-pg'
```

- [ ] **Step 4: Add `PG_TEST_URL` to the env-drift guard's EXCLUDED set**

In `packages/schema/test/env-example.test.ts`, change the `EXCLUDED` set from:
```ts
const EXCLUDED = new Set(['REDIS_TEST_URL', 'NODE_ENV'])
```
to:
```ts
const EXCLUDED = new Set(['REDIS_TEST_URL', 'PG_TEST_URL', 'NODE_ENV'])
```
(Without this, the new `process.env.PG_TEST_URL` read in `real-pg.ts` would fail the drift guard, which demands every first-party `process.env.X` be documented in `.env.example` — but `PG_TEST_URL` is test-only and must stay out of `.env.example`.)

- [ ] **Step 5: Run locally against a throwaway Postgres — expect PASS; and confirm skip-when-unset**

Provision a real Postgres, run the test with the env set, then remove it:
```bash
docker run -d --name mm-test-pg -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test -p 55432:5432 postgres:16-bookworm
# wait ~3s for it to accept connections
PG_TEST_URL='postgres://test:test@localhost:55432/test' pnpm --filter @metamodels/control-plane exec vitest run src/test/real-pg.test.ts
docker rm -f mm-test-pg
```
Expected: 1 test PASSES (real migrate + round-trip).
Then confirm it SKIPS cleanly with the env unset:
Run: `pnpm --filter @metamodels/control-plane exec vitest run src/test/real-pg.test.ts`
Expected: 1 skipped, 0 failed (the `describe.skipIf` short-circuits; no Postgres socket opened).

- [ ] **Step 6: Typecheck + env-drift lane**

Run: `pnpm -w exec tsc -b` → clean.
Run: `pnpm --filter @metamodels/schema exec vitest run test/env-example.test.ts` → PASS (the guard still green with `PG_TEST_URL` excluded).

- [ ] **Step 7: Commit**

```bash
git add apps/control-plane/src/test/real-pg.ts apps/control-plane/src/test/real-pg.test.ts packages/schema/test/env-example.test.ts
git commit -m "test(control-plane): real-Postgres integration harness (PG_TEST_URL) + env-drift exclusion"
```

---

### Task 2: Per-org-lock Postgres concurrency test (seat race + last-admin race)

Prove `acquireOrgLock` (the `SELECT id FROM org … FOR UPDATE` installed in Plan 5.7b) actually serializes concurrent seat-consuming / last-admin mutations under a real multi-connection Postgres — the 5.7a→5.7b carry-forward that pglite could not verify. Two races, each asserting the invariant holds (exactly one winner; the org is never over-provisioned or stranded).

**Files:**
- Create: `apps/control-plane/src/server/org-lock-concurrency.test.ts` (control-plane lane)

**Interfaces:**
- Consumes: `makeRealPgDb`, `PG_TEST_URL`, `uniqueEmail`, `uniqueName` (Task 1); `inviteUser(db, actor, input, seatLimit, nowMs)` + `SeatLimitError` (`invites-service`); `setUserStatus(db, actor, userId, status, seatLimit, nowMs)` (`users-service`); the `user`/`org` tables + `hashPassword` seam. The actor shape is `{ id, orgId, email, role }` (an `Actor`); `requireCapability(actor, 'user.manage')` passes for `role: 'admin'`.

- [ ] **Step 1: Write the failing test**

Create `apps/control-plane/src/server/org-lock-concurrency.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { and, count, eq } from 'drizzle-orm'
import { org, user } from '@metamodels/schema'
import { PG_TEST_URL, makeRealPgDb, uniqueEmail, uniqueName } from '../test/real-pg'
import { inviteUser, SeatLimitError } from './invites-service'
import { setUserStatus } from './users-service'
import type { Actor } from '../auth/authorize'
import type { Db } from './db'

// A concurrency test needs REAL, MULTIPLE Postgres connections: two transactions must be able to
// run at once so a missing FOR UPDATE lock would let both read a stale count. pglite (single
// connection) serializes at the driver and would hide the bug — hence PG_TEST_URL only.
describe.skipIf(!PG_TEST_URL)('acquireOrgLock under real concurrency', () => {
  let db: Db
  let close: () => Promise<void>
  beforeAll(async () => {
    ;({ db, close } = await makeRealPgDb())
  })
  afterAll(async () => {
    await close()
  })

  // Insert an org + an active admin; return the org id and an Actor for that admin.
  async function seedAdmin(): Promise<{ orgId: string; actor: Actor }> {
    const [o] = await db.insert(org).values({ name: uniqueName() }).returning()
    const email = uniqueEmail('admin')
    const [u] = await db
      .insert(user)
      .values({ orgId: o.id, email, role: 'admin', status: 'active', passwordHash: 'x' })
      .returning()
    return { orgId: o.id, actor: { id: u.id, orgId: o.id, email, role: 'admin' } }
  }

  async function activeAdminCount(orgId: string): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(user)
      .where(and(eq(user.orgId, orgId), eq(user.role, 'admin'), eq(user.status, 'active')))
    return row?.n ?? 0
  }

  test('two concurrent invites at the last free seat → exactly one succeeds', async () => {
    const { actor } = await seedAdmin() // 1 active admin fills 1 of 2 seats
    const now = Date.now()
    const seatLimit = 2
    // Two DIFFERENT emails so DuplicateInviteError never fires — both compete for the one free seat.
    const results = await Promise.allSettled([
      inviteUser(db, actor, { email: uniqueEmail('a'), role: 'member' }, seatLimit, now),
      inviteUser(db, actor, { email: uniqueEmail('b'), role: 'member' }, seatLimit, now),
    ])
    const ok = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(ok).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(SeatLimitError)
  })

  test('two concurrent last-two-admin deactivations → org keeps ≥1 admin', async () => {
    // Seed an org with exactly TWO active admins, each acting to deactivate the other.
    const [o] = await db.insert(org).values({ name: uniqueName() }).returning()
    const emailA = uniqueEmail('adminA')
    const emailB = uniqueEmail('adminB')
    const [a] = await db.insert(user).values({ orgId: o.id, email: emailA, role: 'admin', status: 'active', passwordHash: 'x' }).returning()
    const [b] = await db.insert(user).values({ orgId: o.id, email: emailB, role: 'admin', status: 'active', passwordHash: 'x' }).returning()
    const actorA: Actor = { id: a.id, orgId: o.id, email: emailA, role: 'admin' }
    const actorB: Actor = { id: b.id, orgId: o.id, email: emailB, role: 'admin' }
    const now = Date.now()
    const seatLimit = 5 // deactivation ignores seats; a high limit keeps the seat guard out of the way

    const results = await Promise.allSettled([
      setUserStatus(db, actorA, b.id, 'deactivated', seatLimit, now), // A deactivates B
      setUserStatus(db, actorB, a.id, 'deactivated', seatLimit, now), // B deactivates A
    ])
    const ok = results.filter((r) => r.status === 'fulfilled')
    // Exactly one deactivation wins; the other is rejected (LastAdminError, or NotFoundError if the
    // acting user was itself deactivated by the winner first). Either way the org must keep an admin.
    expect(ok).toHaveLength(1)
    expect(await activeAdminCount(o.id)).toBe(1)
  })
})
```

- [ ] **Step 2: Run it — expect skip (env unset), proving no accidental pass**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/org-lock-concurrency.test.ts`
Expected: 2 skipped, 0 failed (guard short-circuits without `PG_TEST_URL`). This is the RED-equivalent for an integration test: it must not pass without a real server.

- [ ] **Step 3: Run locally against a throwaway Postgres — expect PASS**

```bash
docker run -d --name mm-test-pg -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test -p 55432:5432 postgres:16-bookworm
# wait ~3s
PG_TEST_URL='postgres://test:test@localhost:55432/test' pnpm --filter @metamodels/control-plane exec vitest run src/server/org-lock-concurrency.test.ts
docker rm -f mm-test-pg
```
Expected: **2 tests PASS** — exactly one invite succeeds, exactly one deactivation succeeds, org keeps 1 admin. (If a test FAILS with both invites succeeding / zero admins remaining, that is a real lock regression — investigate `acquireOrgLock` wiring, do not weaken the test.)

- [ ] **Step 4: Confirm the field values match the schema (guard against a fabricated-green)**

While iterating, if the insert fails on a column name (e.g. `passwordHash` vs `password_hash`, or `status` default), read `packages/schema/src/schema.ts` for the `user` table and correct the test's `.values({...})` to the real Drizzle column keys — do NOT delete the assertions to make it pass. Re-run Step 3.

- [ ] **Step 5: Typecheck**

Run: `pnpm -w exec tsc -b` → clean.

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane/src/server/org-lock-concurrency.test.ts
git commit -m "test(control-plane): per-org-lock Postgres concurrency test (seat + last-admin races)"
```

---

### Task 3: Config-invalidation pub/sub smoke on real Redis

Prove the Plan 5.6 seam end-to-end on a real Redis: a `publishConfigInvalidation` on one connection reaches `subscribeConfigInvalidation` on a *separate* connection and flushes a `CachingConfigStore`. ioredis-mock cannot cross real connections, so this is the untested boot seam the 5.6 review flagged for Plan 6.

**Files:**
- Create: `apps/data-plane/test/config-pubsub.integration.test.ts` (root lane — `apps/**/test/**`)

**Interfaces:**
- Consumes: `subscribeConfigInvalidation(sub, store)` + `Invalidatable` (`apps/data-plane/src/config/config-invalidation-subscriber.ts`); `publishConfigInvalidation(reason, publisher)` (`apps/control-plane/src/server/config-publisher.ts` — cross-app import is fine in a test); `CachingConfigStore` (`apps/data-plane/src/config/caching-config-store.ts`, ctor `(inner: ConfigStore, { ttlMs?, maxEntries?, now? })`) + its `ConfigStore` interface (methods `resolveKeyByHash(hash)` and `getPaddockBySlug(slug)`); `ioredis` (already a data-plane dep).

- [ ] **Step 1: Write the failing test**

Create `apps/data-plane/test/config-pubsub.integration.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import Redis from 'ioredis'
import { CachingConfigStore } from '../src/config/caching-config-store.js'
import { subscribeConfigInvalidation } from '../src/config/config-invalidation-subscriber.js'
import { publishConfigInvalidation } from '../../control-plane/src/server/config-publisher'
import type { ConfigStore } from '../src/config/config-store.js'

const REDIS_URL = process.env.REDIS_TEST_URL

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Real cross-connection pub/sub: publish on one ioredis client, receive on a duplicated
// subscriber connection, and confirm the CachingConfigStore flushed. ioredis-mock cannot deliver
// across connections, so this runs only against a real Redis (REDIS_TEST_URL) and skips otherwise.
describe.skipIf(!REDIS_URL)('config invalidation pub/sub (real Redis)', () => {
  let pub: Redis
  let sub: Redis
  beforeAll(() => {
    pub = new Redis(REDIS_URL!, { maxRetriesPerRequest: null })
    sub = pub.duplicate()
  })
  afterAll(async () => {
    await sub.quit()
    await pub.quit()
  })

  test('a published invalidation flushes the caching store on the subscriber side', async () => {
    // A fake inner store that counts how many times the cache had to hit it.
    let innerCalls = 0
    const inner: ConfigStore = {
      async resolveKeyByHash() {
        innerCalls++
        return null
      },
      async getPaddockBySlug() {
        return null
      },
    }
    const store = new CachingConfigStore(inner, { ttlMs: 60_000 })

    // Prime the cache: first read hits inner (count 1); a second read is a cache hit (still 1).
    await store.resolveKeyByHash('h')
    await store.resolveKeyByHash('h')
    expect(innerCalls).toBe(1)

    // Wire the real subscriber, then wait for the SUBSCRIBE round-trip to land before publishing.
    subscribeConfigInvalidation(sub, store)
    await sleep(150)

    // Publish on the OTHER connection. This is the seam under test.
    await publishConfigInvalidation('test', pub)

    // Delivery is async; poll — after the flush the next read must hit inner again (count → 2).
    let flushed = false
    for (let i = 0; i < 100; i++) {
      await store.resolveKeyByHash('h')
      if (innerCalls >= 2) {
        flushed = true
        break
      }
      await sleep(20)
    }
    expect(flushed).toBe(true)
  })
})
```
(If the real `ConfigStore` interface path/name differs, adjust the import — Step 4.)

- [ ] **Step 2: Run it — expect skip (env unset)**

Run: `pnpm --filter @metamodels/data-plane exec vitest run test/config-pubsub.integration.test.ts`
(or the root lane `pnpm test` — this file is in `apps/data-plane/test/`, root-lane glob).
Expected: 1 skipped, 0 failed (no `REDIS_TEST_URL`). No Redis socket opened.

- [ ] **Step 3: Run locally against a throwaway Redis — expect PASS**

```bash
docker run -d --name mm-test-redis -p 56379:6379 redis:7-bookworm
REDIS_TEST_URL='redis://localhost:56379' pnpm --filter @metamodels/data-plane exec vitest run test/config-pubsub.integration.test.ts
docker rm -f mm-test-redis
```
Expected: **1 test PASSES** — the published invalidation flushes the store (innerCalls reaches 2 within the poll window).

- [ ] **Step 4: If the import path is wrong, correct it (don't stub the seam)**

If Step 2/3 errors on `../src/config/config-store.js` or the `ConfigStore` type name, read `apps/data-plane/src/config/` to find the real interface export and fix the import. Do NOT replace the real `subscribeConfigInvalidation`/`publishConfigInvalidation` with fakes — the real modules on real Redis are the point.

- [ ] **Step 5: Typecheck**

Run: `pnpm -w exec tsc -b` → clean.

- [ ] **Step 6: Commit**

```bash
git add apps/data-plane/test/config-pubsub.integration.test.ts
git commit -m "test(data-plane): config-invalidation pub/sub smoke on real Redis (REDIS_TEST_URL)"
```

---

### Task 4: CI main workflow — install → build → typecheck → both test lanes (PG+Redis services)

The core pipeline: on push/PR, install with a frozen lockfile, build the control-plane (so `tsc -b` has `.next/types`), typecheck, and run **both** test lanes with `postgres:16` + `redis:7` **service containers** wired to `DATABASE_URL` / `PG_TEST_URL` / `REDIS_TEST_URL` — so the worker consumer-group test, the concurrency test, and the pub/sub test all actually execute in CI.

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Produces: a `test` job (and later a `build-smoke` job in Task 6) triggered on `push` + `pull_request`. No outputs consumed by other tasks except that Task 5's `zizmor` analyzes this file and Task 6 adds a job to it.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/ci.yml` (SHA placeholders `<SHA:…>` are resolved in Step 2 — leave the `@<SHA:...>` tokens exactly as written for now so Step 2's resolver can find them):
```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

# Least privilege: read-only by default. No id-token, no write scopes (nothing publishes here).
permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-bookworm
        env:
          POSTGRES_USER: metamodels
          POSTGRES_PASSWORD: metamodels
          POSTGRES_DB: metamodels
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U metamodels -d metamodels"
          --health-interval 5s --health-timeout 5s --health-retries 10
      redis:
        image: redis:7-bookworm
        ports:
          - 6379:6379
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s --health-timeout 5s --health-retries 10
    env:
      # App URL used by the migrator + any DATABASE_URL-reading code path.
      DATABASE_URL: postgres://metamodels:metamodels@localhost:5432/metamodels
      # Opt-in integration-test URLs — these switch the skipIf suites ON.
      PG_TEST_URL: postgres://metamodels:metamodels@localhost:5432/metamodels
      REDIS_TEST_URL: redis://localhost:6379
    steps:
      - uses: actions/checkout@<SHA:actions/checkout@v4>
      - uses: actions/setup-node@<SHA:actions/setup-node@v4>
        with:
          node-version-file: .nvmrc
      - name: Enable corepack + pin pnpm
        run: corepack enable && corepack prepare pnpm@11.9.0 --activate
      - name: Install (frozen lockfile)
        run: pnpm install --frozen-lockfile
      - name: Apply migrations to the CI Postgres
        # The concurrency/harness tests migrate their own handle, but the worker test and any
        # DATABASE_URL path expect the schema present; run the same one-shot migrator the stack uses.
        run: pnpm --filter @metamodels/migrate start
      - name: Build control-plane (produces .next/types for typecheck)
        run: pnpm --filter @metamodels/control-plane build
      - name: Typecheck
        run: pnpm -w exec tsc -b
      - name: Root test lane (worker + data-plane integration run here)
        run: pnpm test
      - name: Control-plane test lane (concurrency test runs here)
        run: pnpm --filter @metamodels/control-plane exec vitest run --testTimeout=30000
```

- [ ] **Step 2: Pin every third-party action to a full commit SHA**

Replace each `@<SHA:owner/action@vTag>` token with the resolved 40-char commit SHA for that tag, keeping a `# vTag` trailing comment. Resolve them (needs network + optionally `gh`):
```bash
# For each action tag, get the commit SHA it points at:
gh api repos/actions/checkout/git/refs/tags/v4 --jq '.object.sha'      # or the annotated-tag deref
gh api repos/actions/setup-node/git/refs/tags/v4 --jq '.object.sha'
```
Then edit `ci.yml` so each line reads e.g. `- uses: actions/checkout@<40charsha> # v4`.
**If `gh`/network is unavailable in this environment:** this is the one step that cannot complete offline. Do NOT invent a SHA (a wrong SHA breaks CI). Instead: leave the `@<SHA:...>` tokens in place, and report the pin as a **stated deferral** in your task report (exactly like Plan 6a's Docker-daemon-required steps) — the branch is not merged until the SHAs are resolved, and Task 5's `zizmor` job (which fails on unpinned actions) plus Task 7's grep gate will catch any that slip through. Prefer resolving them; defer only if truly offline.

- [ ] **Step 3: Structural self-check (no local runner exists)**

There is no `act`/`actionlint` here, so verify by inspection and grep:
```bash
# No pull_request_target anywhere:
! grep -rn "pull_request_target" .github/workflows/
# No unpinned action refs (every 'uses:' must be @<40-hex> — this prints offenders, expect NONE
# once Step 2 is done; if offline and tokens remain, this lists them as the known deferral):
grep -rnE "uses:\s+[^@]+@(v?[0-9]|main|master)" .github/workflows/ || echo "all actions pinned"
```
Expected: `pull_request_target` grep prints nothing (exit non-zero is fine); the unpinned-action grep prints nothing once SHAs are resolved.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml .nvmrc
git commit -m "ci: workflow — frozen install, build-before-typecheck, both lanes on PG+Redis service containers"
```
(`.nvmrc` already exists at `24`; `git add` is a no-op for it if unchanged — harmless.)

---

### Task 5: Supply-chain hardening — zizmor workflow + CODEOWNERS

Add the required security check (`zizmor` static analysis of the workflows — fails on unpinned actions / known misconfigurations) and a `CODEOWNERS` so workflow changes require review. This is the machine enforcement behind Task 4's manual pin discipline.

**Files:**
- Create: `.github/workflows/zizmor.yml`
- Create: `.github/CODEOWNERS`

**Interfaces:**
- Consumes: the workflows from Task 4 (its analysis target). Produces: a required `zizmor` status check.

- [ ] **Step 1: Write the zizmor workflow**

Create `.github/workflows/zizmor.yml` (resolve the `<SHA:...>` and the zizmor version in Step 2):
```yaml
name: zizmor

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  zizmor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<SHA:actions/checkout@v4>
      # zizmor is a Rust CLI distributed on PyPI; pin the exact version. `pipx run` needs no cache.
      - name: Run zizmor (workflow static analysis)
        run: pipx run zizmor==<ZIZMOR_VERSION> --pedantic .github/workflows/
```

- [ ] **Step 2: Pin the checkout SHA + the zizmor version**

- Replace `@<SHA:actions/checkout@v4>` with the same resolved SHA used in Task 4 (`# v4`).
- Replace `<ZIZMOR_VERSION>` with the current released zizmor version (resolve it):
```bash
# Current zizmor release (needs network):
curl -s https://pypi.org/pypi/zizmor/json | python3 -c "import sys,json;print(json.load(sys.stdin)['info']['version'])"
```
Pin that exact version (e.g. `pipx run zizmor==1.11.0 --pedantic .github/workflows/`). If offline, treat exactly like Task 4 Step 2 — leave the token, report the deferral, do not invent a version.

- [ ] **Step 3: Write CODEOWNERS**

Create `.github/CODEOWNERS`:
```
# Workflow + CI changes require the operator's review — a supply-chain control-point.
/.github/           @carmelosantana
# The lockfile and root build config gate every dependency and CI entrypoint.
/pnpm-lock.yaml     @carmelosantana
/package.json       @carmelosantana
```
(GitHub only enforces CODEOWNERS review when branch protection requires it — the file declares intent; enabling "require review from Code Owners" on the branch is an operator setting, noted in DEPLOY.md Task 7.)

- [ ] **Step 4: Structural self-check**

```bash
# zizmor.yml is itself pinned + no pull_request_target:
grep -rnE "uses:\s+[^@]+@(v?[0-9]|main|master)" .github/workflows/zizmor.yml || echo "pinned"
! grep -rn "pull_request_target" .github/workflows/zizmor.yml
```
Expected: prints `pinned` (once SHA resolved); the `pull_request_target` grep matches nothing.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/zizmor.yml .github/CODEOWNERS
git commit -m "ci: zizmor workflow static-analysis (required check) + CODEOWNERS on .github/"
```

---

### Task 6: CI Docker build + smoke acceptance job

Add a `build-smoke` job to `ci.yml` that builds the Plan-6a images and runs `scripts/smoke.sh` on the runner (GitHub Ubuntu runners have Docker) — the strongest packaging-regression gate.

**Files:**
- Modify: `.github/workflows/ci.yml` (add a `build-smoke` job)

**Interfaces:**
- Consumes: the Plan-6a `docker/Dockerfile`, `docker-compose.yml`, `.env.example`, `scripts/smoke.sh`. Runs independently of the `test` job (both triggered by the same events).

- [ ] **Step 1: Add the job**

Append to `.github/workflows/ci.yml` (under `jobs:`, a sibling of `test`):
```yaml
  build-smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<SHA:actions/checkout@v4>
      # docker + docker compose are preinstalled on ubuntu-latest runners.
      - name: Provide .env for compose interpolation + container secrets
        run: cp .env.example .env
      - name: Smoke the full stack (build → migrate → health → teardown)
        run: ./scripts/smoke.sh
```
(Reuse the same resolved `actions/checkout` SHA. `smoke.sh` builds the images via `docker compose up -d --build`, so no separate `docker build` step is needed; it also tears the stack down via its EXIT trap. `.env.example`'s placeholder secrets are ≥16 chars, satisfying the control-plane's `SESSION_SECRET`/`LICENSE_KEY_SECRET` requirements for the health probes.)

- [ ] **Step 2: Structural self-check**

```bash
# The new job's action is pinned; the file still has no pull_request_target:
grep -rnE "uses:\s+[^@]+@(v?[0-9]|main|master)" .github/workflows/ci.yml || echo "pinned"
! grep -rn "pull_request_target" .github/workflows/ci.yml
```
Expected: `pinned`; no `pull_request_target`.

- [ ] **Step 3: Optionally dry-run the smoke locally (Docker is available here)**

The smoke itself was proven in Plan 6a; re-running is optional but cheap confirmation the job's single command works from a clean `.env`:
```bash
cp .env.example .env && ./scripts/smoke.sh
```
Expected: `== smoke passed ==`, exit 0. (If you run it, note it in the report; if you skip it, say so — do not claim it ran.)

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: build-smoke job — docker compose stack smoke on the runner (v1 acceptance gate)"
```

---

### Task 7: Docs (integration-test runbook) + verification gate

Document how to run the integration tests locally (the two env vars + a throwaway PG/Redis), note the CODEOWNERS branch-protection setting, and run the full verification gate honestly (local tests green; CI authored + statically checked, first real run on push).

**Files:**
- Modify: `docs/DEPLOY.md` (add a "Running the integration tests" + "CI" section)

- [ ] **Step 1: Add the docs section**

Append to `docs/DEPLOY.md` (before the "Deploy gotchas" section, or at the end):
````markdown
## Running the integration tests

Most tests run with zero setup (pglite + ioredis-mock, Docker-free). Three suites need **real** servers and are **skipped unless** their env var is set — they never run against your production data:

| Suite | Env var | What it proves |
|-------|---------|----------------|
| `apps/worker/test/worker.test.ts` | `REDIS_TEST_URL` | worker consumer-group read→apply→ack wiring |
| `apps/data-plane/test/config-pubsub.integration.test.ts` | `REDIS_TEST_URL` | config-invalidation pub/sub flushes the data-plane cache across connections |
| `apps/control-plane/src/server/org-lock-concurrency.test.ts` | `PG_TEST_URL` | the per-org `FOR UPDATE` lock serializes concurrent seat/last-admin mutations |

Run them locally against throwaway containers:
```bash
docker run -d --name mm-pg -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test -p 55432:5432 postgres:16-bookworm
docker run -d --name mm-redis -p 56379:6379 redis:7-bookworm
export PG_TEST_URL='postgres://test:test@localhost:55432/test'
export REDIS_TEST_URL='redis://localhost:56379'
pnpm test                                                   # root lane (worker + pub/sub run)
pnpm --filter @metamodels/control-plane exec vitest run     # control-plane lane (concurrency runs)
docker rm -f mm-pg mm-redis
```

## Continuous integration

`.github/workflows/ci.yml` runs on every push/PR: frozen-lockfile install → control-plane build (needed before `tsc -b`, which reads `.next/types`) → typecheck → both test lanes with `postgres:16`+`redis:7` **service containers** (so all three integration suites above execute in CI) → a `build-smoke` job that runs `scripts/smoke.sh` on the full Docker stack. `.github/workflows/zizmor.yml` statically analyzes the workflows (fails on unpinned actions / misconfig). All third-party actions are pinned to full commit SHAs.

**Operator setup:** enable branch protection on `main` requiring the `test`, `build-smoke`, and `zizmor` checks and "review from Code Owners" (so `.github/CODEOWNERS` is enforced).
````

- [ ] **Step 2: Commit the docs**

```bash
git add docs/DEPLOY.md
git commit -m "docs: integration-test runbook (PG_TEST_URL/REDIS_TEST_URL) + CI overview"
```

- [ ] **Step 3: Verification gate — local, honest**

Run and record each:
- `pnpm -w exec tsc -b` → clean.
- `pnpm test` (env UNSET) → **root 192 pass / 4 skip** (baseline 192/3; the new pub/sub test SKIPS without `REDIS_TEST_URL` → +1 skip, so pass count is unchanged and skips go 3→4; the 3 worker skips unchanged). Confirm the exact numbers.
- `pnpm --filter @metamodels/control-plane exec vitest run --testTimeout=30000` (env UNSET) → **control-plane 167 pass + 3 skipped** (baseline 167 + the harness round-trip (1) + the 2 concurrency tests, all skipping without `PG_TEST_URL`). Confirm the exact numbers.
- With `PG_TEST_URL` + `REDIS_TEST_URL` set (throwaway containers, as in Task 1/2/3 Step commands): both lanes with **zero skips among the new suites** — the harness (1) + concurrency (2) run green in the control-plane lane; the pub/sub (1) + worker (3) run green in the root lane. Record the run counts.

- [ ] **Step 4: CI honesty statement (no commit)**

State clearly in your report: the `.github/workflows/*.yml` files are authored and structurally validated (grep gates: no `pull_request_target`, all actions SHA-pinned), but **were not executed** — there is no GitHub remote and no local Actions runner. Their first real run happens on push. If any action SHA or the zizmor version could not be resolved offline, name exactly which, as a stated deferral (must be resolved before the workflows' first push).

---

## Self-Review

**Spec coverage (roadmap Plan 6 → 6b carry-forwards):**
- Per-org-lock Postgres concurrency test (5.7a→5.7b carry-forward) → Task 1 (harness) + Task 2. ✓
- Worker consumer-group `skipIf(REDIS_TEST_URL)` test on real Redis (Plan 4 carry-forward) → runs in CI via Task 4's service container (no test rewrite needed — it already exists). ✓
- Config pub/sub boot smoke on real Redis (Plan 5.6 carry-forward) → Task 3. ✓
- CI hardening — GitHub Actions, zizmor required check, SHA-pinned actions, frozen-lockfile, CODEOWNERS, no `pull_request_target`, least-privilege `permissions`, no `id-token` → Tasks 4/5. ✓
- typecheck-needs-build gotcha (control-plane `tsc -b` needs `.next/types`) → Task 4 builds before typecheck; documented Task 7. ✓
- Docker build + smoke acceptance in CI (Carmelo's decision) → Task 6. ✓
- **Deferred beyond 6b (stated):** Plan 6c = the LS revalidation scheduler (`apps/scheduler`). Not in scope here. The 5.3 template-array RMW `SELECT FOR UPDATE`, `UNIQUE(key_id,paddock_id)`, finish-config-dedup, and unify-24h remain small later touches, not 6b deliverables.

**Placeholder scan:** every test carries complete code; the only intentional deferrable tokens are the action-SHA / zizmor-version pins in Tasks 4/5 — these are concrete resolve-and-verify steps (with the exact `gh api` / `curl pypi` commands), not vague TODOs, and are gated by grep + zizmor. The `type` import in Task 1 Step 2 is a deliberate RED trigger, removed in Step 3.

**Type/name consistency:** `PG_TEST_URL`/`makeRealPgDb`/`uniqueEmail`/`uniqueName` (Task 1) are consumed verbatim by Tasks 2 & the round-trip; `inviteUser(db,actor,input,seatLimit,nowMs)`/`SeatLimitError` and `setUserStatus(db,actor,userId,status,seatLimit,nowMs)` match the real signatures read from source; `subscribeConfigInvalidation(sub,store)`/`publishConfigInvalidation(reason,pub)`/`CachingConfigStore(inner,{ttlMs})` match `apps/data-plane`/`apps/control-plane` source; the CI env var names (`DATABASE_URL`/`PG_TEST_URL`/`REDIS_TEST_URL`) match the tests' `process.env` reads and Task 7's runbook; the `zizmor`/`test`/`build-smoke` job names match Task 7's branch-protection note.

**Decisions flagged for the reviewer:** (1) integration tests are `skipIf`-gated and MUST skip (not pass) without their env — the "RED" for each is the skip-when-unset run; (2) the concurrency harness uses `postgres({ max: 8 })` deliberately (a single-connection pool would mask a missing lock); (3) CI YAML cannot be executed locally (no remote, no `act`/`actionlint`/`zizmor` installed) — authored + grep-validated only, first real run on push, and any unresolvable-offline SHA/version pin is a stated deferral, never a fabricated value.
