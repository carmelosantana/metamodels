# MetaModels Plan 6c — Lemon Squeezy Revalidation Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a background scheduler that periodically re-validates every org's Lemon Squeezy entitlement, so a license can expire (or a remote change land) **without waiting for an operator to log in** — the 7-day offline grace covers the gap between passes.

**Architecture:** The revalidation logic already lives in the control-plane (`revalidateLicense(db, orgId, deps)` — background-safe: no `Actor`, transport errors no-op, grace preserved). This plan adds (1) a cross-org enumerator `listEntitledOrgIds(db)`, (2) an orchestrator `revalidateAllEntitlements(db, deps, revalidate?)` that runs one pass over all entitled orgs with per-org isolation, (3) a thin loop entrypoint **`apps/control-plane/bin/scheduler.ts`** (mirroring the existing `bin/seed.ts`, which already imports `../src/server/*` and typechecks under the control-plane tsconfig), and (4) a compose `scheduler` service reusing the Plan-6a `tsx-app` image with `APP=control-plane` + a command override (**no Dockerfile change**). The scheduler is a control-plane entrypoint, not a separate `apps/` package — a deliberate choice (see Global Constraints) because the licensing domain is coupled to control-plane's `authorize`/`audit` and its Next-flavored (`noEmit`, non-`composite`, Bundler-resolution) tsconfig cannot be cleanly imported by a standalone tsx app under `tsc -b`.

**Tech Stack:** TypeScript ESM · Drizzle + `postgres`-js · the existing `LemonSqueezyClient` (injected `fetchImpl`, real `fetch` in prod) · `tsx` at runtime · Docker Compose (Plan-6a `tsx-app` target) · Vitest + pglite (control-plane lane).

## Global Constraints

- **Node `>=24`; ESM only.** No new runtime dependency — `postgres`, `drizzle-orm`, `tsx`, and the LS client are all already present in the control-plane.
- **Determinism unaffected.** Services take an injected `nowMs`; only the top-level loop entrypoint reads `Date.now()`. Tests inject a fixed `nowMs` (`NOW = 1_800_000_000_000`) and never call `Date.now()` inside a service.
- **`revalidateLicense` is the offline-grace brain — do NOT change its semantics.** A transport error changes nothing (grace preserves last-good state); a definitive `valid:false` downgrades status but keeps the running grace clock; `valid:true` extends grace. The new orchestrator only *loops* it — it adds no new grace/validation logic.
- **The scheduler is a control-plane entrypoint, NOT `apps/scheduler`.** Decided with Carmelo (2026-07-29), revising the earlier "own app" note once the tsconfig boundary was understood: the license modules (`license-service`/`entitlement-service`/`ls-client`/`license-crypto`) are coupled to control-plane `authorize`/`audit` and compile only under control-plane's tsconfig. `bin/scheduler.ts` sits beside `bin/seed.ts` (proven to import `../src/server/*` and typecheck). No new HTTP endpoint, no new shared secret, no `apps/scheduler` package, no Dockerfile change.
- **Cadence: every 12h, env-configurable.** `DEFAULT_INTERVAL_MS = 43_200_000` (12h). `SCHEDULER_INTERVAL_MS` overrides it. A pass revalidates **all** entitled orgs (no due-window filtering — a self-hosted instance is typically one org; note due-filtering as a later scale optimization, not a v1 deliverable).
- **Per-org isolation.** One org's failure must never abort the pass. `revalidateAllEntitlements` wraps each org in try/catch and returns `{ total, ok, failed }`; it takes the per-org revalidate fn as an injected parameter (defaulting to the real `revalidateLicense`) so the isolation is testable with a deliberately-throwing stub.
- **Env-drift guard (Plan 6a).** `packages/schema/test/env-example.test.ts` scans first-party `process.env.X` reads under `apps/` and asserts each is documented in `.env.example`. The new `process.env.SCHEDULER_INTERVAL_MS` read in `bin/scheduler.ts` **must** be added to `.env.example` (it is an operator-facing config, like `PORT`/`WORKER_NAME` — documented, NOT excluded).
- **Test lanes (vitest globs):** control-plane `pnpm --filter @metamodels/control-plane exec vitest run` globs `src/**/*.test.ts`; root `pnpm test` globs `packages/**/test/**` + `apps/**/test/**/*.test.ts`. All new *tested* logic lives in `src/server/*.ts` (control-plane lane). `bin/scheduler.ts` is a thin loop with no vitest test (mirrors `apps/worker/src/index.ts` + `bin/seed.ts`) — its meaningful logic (`revalidateAllEntitlements`, `resolveIntervalMs`) is extracted into `src/` and tested there. Baselines to keep green: **root 192 pass / 4 skip**, **control-plane 167 pass / 3 skip** (unset), `pnpm -w exec tsc -b` clean. (Two pre-existing scrypt tests can time out under CPU contention — re-run the control-plane lane with `--testTimeout=30000`.)
- **Compose `.env` is interpolation-only** (fills `${…}` in the compose file), NOT injected into containers — so the `scheduler` service must list `DATABASE_URL`/`LICENSE_KEY_SECRET`/`SCHEDULER_INTERVAL_MS` explicitly in its own `environment:` block (the Plan-6a Critical). Use `${SCHEDULER_INTERVAL_MS:-43200000}` so an unset var doesn't warn.
- **Git identity:** `Carmelo Santana <me@carmelosantana.com>`. Branch: `feat/metamodels-plan6c` off `main` `690c3fb`.

---

## File Structure

```
apps/control-plane/src/server/entitlement-service.ts   # MODIFY: + listEntitledOrgIds(db)
apps/control-plane/src/server/entitlement-service.test.ts # MODIFY: + listEntitledOrgIds tests
apps/control-plane/src/server/license-service.ts       # MODIFY: + revalidateAllEntitlements(db, deps, revalidate?)
apps/control-plane/src/server/license-service.test.ts  # MODIFY: + revalidateAllEntitlements tests (all-orgs + per-org isolation)
apps/control-plane/src/server/scheduler.ts             # CREATE: resolveIntervalMs(raw) + DEFAULT_INTERVAL_MS (pure, testable)
apps/control-plane/src/server/scheduler.test.ts        # CREATE: resolveIntervalMs tests
apps/control-plane/bin/scheduler.ts                    # CREATE: thin loop entrypoint (mirrors bin/seed.ts + worker index.ts; no vitest test)
apps/control-plane/package.json                        # MODIFY: + "scheduler": "tsx bin/scheduler.ts" script
docker-compose.yml                                     # MODIFY: + scheduler service (tsx-app, APP=control-plane, command override)
.env.example                                           # MODIFY: + SCHEDULER_INTERVAL_MS (documented)
docs/DEPLOY.md                                          # MODIFY: scheduler service + SCHEDULER_INTERVAL_MS note
```

**Decisions already made (surfaced to Carmelo, applied here):**
1. **Scheduler = control-plane `bin/scheduler.ts` entrypoint + a compose service** reusing the `tsx-app` image (`APP=control-plane`, command override) — not `apps/scheduler`, not an HTTP endpoint. DRY (imports the real license code directly), no new secret, no Dockerfile change.
2. **Cadence 12h, env-configurable** via `SCHEDULER_INTERVAL_MS` (default `43_200_000`).
3. **Every pass revalidates all entitled orgs** (no due-window filter in v1).

---

### Task 1: `listEntitledOrgIds` — enumerate every org with an entitlement

The scheduler needs the set of orgs to revalidate. Every `entitlement` row has a `licenseKeyEnc` (NOT NULL), so "has an entitlement row" == "has a license key to revalidate". Add a tiny cross-org read (no org-scoping — this is a background enumerator, deliberately not `requireCapability`-gated because it takes no actor).

**Files:**
- Modify: `apps/control-plane/src/server/entitlement-service.ts`
- Modify: `apps/control-plane/src/server/entitlement-service.test.ts`

**Interfaces:**
- Produces: `listEntitledOrgIds(db: Db): Promise<string[]>` — returns the `orgId` of every `entitlement` row (deterministic order not required; the scheduler iterates them all).

- [ ] **Step 1: Write the failing test**

Add to `apps/control-plane/src/server/entitlement-service.test.ts` (inside the existing `describe('entitlement-service', ...)` block, after the last test). Reuse the file's existing imports (`freshDb`, `seedOrg`, `saveEntitlement`, `GRACE_MS`, `NOW`, `SECRET`, `admin`) and add `listEntitledOrgIds` to the import from `./entitlement-service`:

```ts
  test('listEntitledOrgIds returns every org that has an entitlement, and excludes orgs without one', async () => {
    const db = await freshDb()
    const o1 = await seedOrg(db, 'org-one@x.io')
    const o2 = await seedOrg(db, 'org-two@x.io')
    const o3 = await seedOrg(db, 'org-three@x.io') // no entitlement — must be excluded
    const ent = { instanceId: 'i', status: 'active', seats: 5, tier: 'Team 5', lastValidatedAt: new Date(NOW), graceUntil: new Date(NOW + GRACE_MS) }
    await saveEntitlement(db, admin(o1.id), { ...ent, licenseKey: 'K1' }, NOW, SECRET)
    await saveEntitlement(db, admin(o2.id), { ...ent, licenseKey: 'K2' }, NOW, SECRET)

    const ids = await listEntitledOrgIds(db)
    expect([...ids].sort()).toEqual([o1.id, o2.id].sort())
    expect(ids).not.toContain(o3.id)
  })
```

Update the import line in the test file from:
```ts
import {
  getEntitlement, getDecryptedKey, saveEntitlement, updateValidation, clearEntitlement,
  resolveSeatsForVariant, resolveEntitlementSeats, GRACE_MS,
} from './entitlement-service'
```
to include `listEntitledOrgIds`:
```ts
import {
  getEntitlement, getDecryptedKey, saveEntitlement, updateValidation, clearEntitlement,
  resolveSeatsForVariant, resolveEntitlementSeats, GRACE_MS, listEntitledOrgIds,
} from './entitlement-service'
```

> **`seedOrg` signature (confirmed):** `seedOrg(db: TestDb, name = 'default'): Promise<{ id: string; ... }>` (`apps/control-plane/src/test/db.ts:21`) — the second arg is the org **name**. The three calls above pass distinct names, which is all the test needs (three distinct org ids). It returns the inserted `org` row (`.id` is used).

- [ ] **Step 2: Run it — expect fail**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/entitlement-service.test.ts`
Expected: FAIL — `listEntitledOrgIds` is not exported (import/compile error).

- [ ] **Step 3: Implement `listEntitledOrgIds`**

In `apps/control-plane/src/server/entitlement-service.ts`, add (near `getEntitlement`; the file already imports `entitlement` from `@metamodels/schema` and `Db`):

```ts
/** Background enumerator: every org that has an entitlement row (i.e. a license key to revalidate).
 *  Deliberately NOT org-scoped / capability-gated — it takes no actor and is only reachable from the
 *  server-internal revalidation scheduler, never a request handler. */
export async function listEntitledOrgIds(db: Db): Promise<string[]> {
  const rows = await db.select({ orgId: entitlement.orgId }).from(entitlement)
  return rows.map((r) => r.orgId)
}
```

- [ ] **Step 4: Run it — expect pass**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/entitlement-service.test.ts`
Expected: PASS (the new test + all pre-existing entitlement-service tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm -w exec tsc -b` → clean.

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane/src/server/entitlement-service.ts apps/control-plane/src/server/entitlement-service.test.ts
git commit -m "feat(control-plane): listEntitledOrgIds — enumerate orgs with an entitlement for the scheduler"
```

---

### Task 2: `revalidateAllEntitlements` — one isolated pass over all entitled orgs

The orchestrator the scheduler runs each tick: enumerate entitled orgs, revalidate each with per-org isolation, return counts. The per-org revalidate fn is injected (default = the real `revalidateLicense`) so a test can prove isolation with a deliberately-throwing stub.

**Files:**
- Modify: `apps/control-plane/src/server/license-service.ts`
- Modify: `apps/control-plane/src/server/license-service.test.ts`

**Interfaces:**
- Consumes: `listEntitledOrgIds(db)` (Task 1); `revalidateLicense(db, orgId, deps)` + `LicenseDeps` (existing, same file).
- Produces: `revalidateAllEntitlements(db: Db, deps: LicenseDeps, revalidate?: (db: Db, orgId: string, deps: LicenseDeps) => Promise<void>): Promise<{ total: number; ok: number; failed: number }>` — `revalidate` defaults to `revalidateLicense`; each org is wrapped in try/catch (a throw increments `failed` and is logged, never propagated); returns the tallies.

- [ ] **Step 1: Write the failing tests**

Add to `apps/control-plane/src/server/license-service.test.ts`. The file already imports `freshDb`, `seedOrg`, `activateLicense`, `revalidateLicense`, `getEntitlement`, `GRACE_MS`, `LemonSqueezyClient`, `fakeLs`, `admin`, `SECRET`, `NOW`. Add `revalidateAllEntitlements` to the `./license-service` import, then append a new `describe`:

```ts
describe('revalidateAllEntitlements', () => {
  const okLs = () => fakeLs({
    activate: { valid: true, status: 'active', instanceId: 'i', variantName: 'Team 5' },
    validate: { valid: true, status: 'active', instanceId: 'i', variantName: 'Team 5' },
  })

  test('revalidates every entitled org and reports counts', async () => {
    const db = await freshDb()
    const o1 = await seedOrg(db, 'a@x.io')
    const o2 = await seedOrg(db, 'b@x.io')
    await activateLicense(db, admin(o1.id), 'K1', 'box1', { ls: okLs(), secret: SECRET, nowMs: NOW })
    await activateLicense(db, admin(o2.id), 'K2', 'box2', { ls: okLs(), secret: SECRET, nowMs: NOW })

    // A later pass: valid:true again → grace extends to LATER+GRACE_MS for both.
    const LATER = NOW + 60_000
    const res = await revalidateAllEntitlements(db, { ls: okLs(), secret: SECRET, nowMs: LATER })
    expect(res).toEqual({ total: 2, ok: 2, failed: 0 })
    expect((await getEntitlement(db, o1.id))?.graceUntil?.getTime()).toBe(LATER + GRACE_MS)
    expect((await getEntitlement(db, o2.id))?.graceUntil?.getTime()).toBe(LATER + GRACE_MS)
  })

  test('one org failing does not abort the pass (per-org isolation)', async () => {
    const db = await freshDb()
    const o1 = await seedOrg(db, 'a@x.io')
    const o2 = await seedOrg(db, 'b@x.io')
    await activateLicense(db, admin(o1.id), 'K1', 'box1', { ls: okLs(), secret: SECRET, nowMs: NOW })
    await activateLicense(db, admin(o2.id), 'K2', 'box2', { ls: okLs(), secret: SECRET, nowMs: NOW })

    // Inject a revalidate stub that throws for exactly one org id.
    const failFor = o1.id
    const revalidate = async (_db: typeof db, orgId: string) => {
      if (orgId === failFor) throw new Error('boom')
    }
    const res = await revalidateAllEntitlements(db, { ls: okLs(), secret: SECRET, nowMs: NOW }, revalidate)
    expect(res.total).toBe(2)
    expect(res.ok).toBe(1)
    expect(res.failed).toBe(1)
  })

  test('an empty instance revalidates nothing', async () => {
    const db = await freshDb()
    const res = await revalidateAllEntitlements(db, { ls: okLs(), secret: SECRET, nowMs: NOW })
    expect(res).toEqual({ total: 0, ok: 0, failed: 0 })
  })
})
```

Update the `./license-service` import to add `revalidateAllEntitlements`:
```ts
import { activateLicense, deactivateLicense, revalidateLicense, revalidateAllEntitlements } from './license-service'
```

- [ ] **Step 2: Run it — expect fail**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/license-service.test.ts`
Expected: FAIL — `revalidateAllEntitlements` not exported.

- [ ] **Step 3: Implement `revalidateAllEntitlements`**

In `apps/control-plane/src/server/license-service.ts`, add `listEntitledOrgIds` to the existing `./entitlement-service` import, then add the orchestrator at the end of the file:

```ts
import {
  saveEntitlement, updateValidation, clearEntitlement, getEntitlement, getDecryptedKey,
  resolveSeatsForVariant, GRACE_MS, listEntitledOrgIds,
} from './entitlement-service'
```

```ts
/**
 * One scheduler pass: revalidate every entitled org's license, isolated per org so a single failure
 * never aborts the rest. `revalidate` is injectable for testing; production uses `revalidateLicense`,
 * whose own try/catch already turns a transport error into a no-op (grace preserves last-good state).
 */
export async function revalidateAllEntitlements(
  db: Db,
  deps: LicenseDeps,
  revalidate: (db: Db, orgId: string, deps: LicenseDeps) => Promise<void> = revalidateLicense,
): Promise<{ total: number; ok: number; failed: number }> {
  const orgIds = await listEntitledOrgIds(db)
  let ok = 0
  let failed = 0
  for (const orgId of orgIds) {
    try {
      await revalidate(db, orgId, deps)
      ok++
    } catch (err) {
      failed++
      // eslint-disable-next-line no-console
      console.error(`revalidate failed for org ${orgId}`, err)
    }
  }
  return { total: orgIds.length, ok, failed }
}
```

- [ ] **Step 4: Run it — expect pass**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/license-service.test.ts`
Expected: PASS (3 new tests + all pre-existing license-service tests). Output pristine except the intentional `console.error` from the isolation test — that is expected (a real failure is logged); it is not a warning about the test itself.

- [ ] **Step 5: Typecheck**

Run: `pnpm -w exec tsc -b` → clean.

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane/src/server/license-service.ts apps/control-plane/src/server/license-service.test.ts
git commit -m "feat(control-plane): revalidateAllEntitlements — one isolated pass over all entitled orgs"
```

---

### Task 3: `resolveIntervalMs` helper + `bin/scheduler.ts` loop entrypoint

The pure interval parser (tested) and the thin loop that drives `revalidateAllEntitlements` on a timer (untested, like `apps/worker/src/index.ts` and `bin/seed.ts`).

**Files:**
- Create: `apps/control-plane/src/server/scheduler.ts`
- Create: `apps/control-plane/src/server/scheduler.test.ts`
- Create: `apps/control-plane/bin/scheduler.ts`
- Modify: `apps/control-plane/package.json` (add the `"scheduler"` script)

**Interfaces:**
- Consumes: `revalidateAllEntitlements` (Task 2); `getDb` (`./server/db`); `licenseSecret` (`./server/license-service`); `LemonSqueezyClient` (`./server/ls-client`).
- Produces: `DEFAULT_INTERVAL_MS = 43_200_000`; `resolveIntervalMs(raw: string | undefined): number` — returns the parsed positive-integer override, else `DEFAULT_INTERVAL_MS` for unset/blank/non-numeric/≤0.

- [ ] **Step 1: Write the failing test**

Create `apps/control-plane/src/server/scheduler.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import { DEFAULT_INTERVAL_MS, resolveIntervalMs } from './scheduler'

describe('resolveIntervalMs', () => {
  test('defaults to 12h when unset', () => {
    expect(DEFAULT_INTERVAL_MS).toBe(43_200_000)
    expect(resolveIntervalMs(undefined)).toBe(DEFAULT_INTERVAL_MS)
    expect(resolveIntervalMs('')).toBe(DEFAULT_INTERVAL_MS)
  })

  test('uses a valid positive-integer override', () => {
    expect(resolveIntervalMs('3600000')).toBe(3_600_000)
  })

  test('falls back to the default for non-numeric or non-positive input', () => {
    expect(resolveIntervalMs('abc')).toBe(DEFAULT_INTERVAL_MS)
    expect(resolveIntervalMs('0')).toBe(DEFAULT_INTERVAL_MS)
    expect(resolveIntervalMs('-5')).toBe(DEFAULT_INTERVAL_MS)
    expect(resolveIntervalMs('1.5')).toBe(DEFAULT_INTERVAL_MS)
  })
})
```

- [ ] **Step 2: Run it — expect fail**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/scheduler.test.ts`
Expected: FAIL — `./scheduler` does not exist.

- [ ] **Step 3: Implement `scheduler.ts`**

Create `apps/control-plane/src/server/scheduler.ts`:
```ts
/** Default revalidation cadence: 12 hours. The 7-day offline grace absorbs any missed pass. */
export const DEFAULT_INTERVAL_MS = 43_200_000

/** Parse the SCHEDULER_INTERVAL_MS override; fall back to the default for unset/blank/non-numeric/≤0. */
export function resolveIntervalMs(raw: string | undefined): number {
  if (!raw) return DEFAULT_INTERVAL_MS
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_INTERVAL_MS
  return n
}
```

- [ ] **Step 4: Run it — expect pass**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/scheduler.test.ts`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Write the loop entrypoint**

Create `apps/control-plane/bin/scheduler.ts` (mirrors `apps/worker/src/index.ts`'s thin `main()` + direct-exec guard and `bin/seed.ts`'s `../src/server/*` imports; no vitest test — its logic is the tested `revalidateAllEntitlements`/`resolveIntervalMs`):
```ts
import { getDb } from '../src/server/db'
import { LemonSqueezyClient } from '../src/server/ls-client'
import { licenseSecret, revalidateAllEntitlements } from '../src/server/license-service'
import { resolveIntervalMs } from '../src/server/scheduler'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  const db = getDb() // throws if DATABASE_URL is unset
  const secret = licenseSecret() // throws if LICENSE_KEY_SECRET is unset/<16
  const intervalMs = resolveIntervalMs(process.env.SCHEDULER_INTERVAL_MS)

  let stopping = false
  const stop = () => { stopping = true }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)

  // eslint-disable-next-line no-console
  console.log(`metamodels scheduler: revalidating every ${intervalMs}ms`)

  // Run one pass immediately on start, then every intervalMs until a stop signal.
  while (!stopping) {
    try {
      const deps = { ls: new LemonSqueezyClient(), secret, nowMs: Date.now() }
      const res = await revalidateAllEntitlements(db, deps)
      // eslint-disable-next-line no-console
      console.log(`revalidation pass: ${res.ok}/${res.total} ok, ${res.failed} failed`)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('revalidation pass crashed; will retry next interval', err)
    }
    if (stopping) break
    await sleep(intervalMs)
  }
}

// Only run when executed directly, not when imported.
if (process.argv[1] && process.argv[1].endsWith('scheduler.ts')) {
  void main()
}
```

- [ ] **Step 6: Add the `scheduler` script**

In `apps/control-plane/package.json`, add a `"scheduler"` script beside the existing `"seed"` script (which is `"seed": "tsx bin/seed.ts"`):
```json
    "scheduler": "tsx bin/scheduler.ts",
```
(Place it inside the existing `"scripts": { ... }` object. Do not remove or reorder other scripts. If `"seed"` is present, put `"scheduler"` next to it.)

- [ ] **Step 7: Typecheck (proves bin/scheduler.ts compiles under the control-plane tsconfig)**

Run: `pnpm -w exec tsc -b` → clean. (This is the load-bearing check that the `bin/` → `../src/server/*` imports resolve — the same pattern `bin/seed.ts` already relies on.)

- [ ] **Step 8: Smoke the entrypoint once against a throwaway Postgres (Docker available)**

Prove `main()` runs a pass and exits cleanly on SIGINT. With no entitlements it does zero LS calls (safe — no network):
```bash
docker run -d --name mm-sched-pg -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test -p 55432:5432 postgres:16-bookworm
# wait ~3s, then apply migrations so the entitlement table exists:
DATABASE_URL='postgres://test:test@localhost:55432/test' pnpm --filter @metamodels/migrate start
# run one pass then Ctrl-C-equivalent after it logs:
DATABASE_URL='postgres://test:test@localhost:55432/test' LICENSE_KEY_SECRET='scheduler-smoke-secret-16chars' SCHEDULER_INTERVAL_MS='60000' \
  timeout 8s pnpm --filter @metamodels/control-plane exec tsx bin/scheduler.ts || true
docker rm -f mm-sched-pg
```
Expected: logs `metamodels scheduler: revalidating every 60000ms` then `revalidation pass: 0/0 ok, 0 failed`, then the `timeout` ends it. (Report the literal output; if you skip it, say so — do not claim it ran.)

- [ ] **Step 9: Commit**

```bash
git add apps/control-plane/src/server/scheduler.ts apps/control-plane/src/server/scheduler.test.ts apps/control-plane/bin/scheduler.ts apps/control-plane/package.json
git commit -m "feat(control-plane): bin/scheduler.ts revalidation loop + resolveIntervalMs (12h default)"
```

---

### Task 4: Package the scheduler — compose service + `.env.example` + docs

Wire the scheduler into `docker compose up`: a `scheduler` service reusing the Plan-6a `tsx-app` image with `APP=control-plane` and a command override (**no Dockerfile change**), gated on the DB being healthy and migrations complete. Document `SCHEDULER_INTERVAL_MS` (keeping the env-drift guard green) and note the service in DEPLOY.md.

**Files:**
- Modify: `docker-compose.yml`
- Modify: `.env.example`
- Modify: `docs/DEPLOY.md`

- [ ] **Step 1: Add `SCHEDULER_INTERVAL_MS` to `.env.example`**

Append to `.env.example` (after the worker block):
```
# --- Scheduler: license re-validation cadence in ms (optional; default 12h = 43200000) ---
SCHEDULER_INTERVAL_MS=43200000
```
(This is required: `bin/scheduler.ts` reads `process.env.SCHEDULER_INTERVAL_MS`, and the Plan-6a env-drift guard fails if a first-party `process.env.X` read is undocumented.)

- [ ] **Step 2: Verify the env-drift guard stays green**

Run: `pnpm --filter @metamodels/schema exec vitest run test/env-example.test.ts`
(or run the whole root lane — the guard is a root-lane test.)
Expected: PASS — `SCHEDULER_INTERVAL_MS` is now documented, so the new `process.env.SCHEDULER_INTERVAL_MS` read is covered.

- [ ] **Step 3: Add the `scheduler` service to `docker-compose.yml`**

Add a `scheduler` service as a sibling of `worker` (before the top-level `volumes:` key). It reuses the `tsx-app` target with `APP: control-plane` (so `WORKDIR=/app/apps/control-plane`) and overrides the command to run the scheduler bin. It needs the DB + `LICENSE_KEY_SECRET`, NOT Redis, and no host port / healthcheck (it's a loop, like `worker`):
```yaml
  scheduler:
    build:
      context: .
      dockerfile: docker/Dockerfile
      target: tsx-app
      args:
        APP: control-plane
    command: ["pnpm", "exec", "tsx", "bin/scheduler.ts"]
    environment:
      DATABASE_URL: ${DATABASE_URL}
      LICENSE_KEY_SECRET: ${LICENSE_KEY_SECRET}
      SCHEDULER_INTERVAL_MS: ${SCHEDULER_INTERVAL_MS:-43200000}
    depends_on:
      postgres:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
```
(Compose `.env` is interpolation-only, so the three vars MUST be listed here explicitly — the Plan-6a Critical. `${SCHEDULER_INTERVAL_MS:-43200000}` supplies the default so an unset var doesn't warn. The `tsx-app` target's default `CMD pnpm start` is overridden by `command:`.)

- [ ] **Step 4: Validate the compose file (Docker available)**

Run: `docker compose config -q`
Expected: exit 0 (no error). Then confirm the scheduler resolved with its env and command:
```bash
docker compose config | sed -n '/  scheduler:/,/^  [a-z]/p'
```
Expected: shows `command: [pnpm, exec, tsx, bin/scheduler.ts]`, the three env vars resolved, and the two `depends_on` conditions. (If Docker is unavailable, say so and validate by careful inspection — do not claim `config -q` ran.)

- [ ] **Step 5: Document the scheduler in DEPLOY.md**

In `docs/DEPLOY.md`, find the licensing paragraph that ends "*(A background re-validation scheduler is Plan 6c.)*" and replace that parenthetical with a real subsection. Append after the licensing paragraph:
```markdown

### License re-validation scheduler

The `scheduler` service re-validates every org's Lemon Squeezy entitlement on a timer, so a license can lapse (or a remote change take effect) without waiting for an operator to log in — the 7-day offline grace covers the gap between passes. Cadence is `SCHEDULER_INTERVAL_MS` (default 12h = `43200000`). It needs `DATABASE_URL` + `LICENSE_KEY_SECRET`, runs a pass on startup then every interval, and isolates each org (one failure never aborts the pass). Run exactly one scheduler instance (it has no leader election).
```
Also, if the licensing paragraph still contains the literal "*(A background re-validation scheduler is Plan 6c.)*", delete that now-stale parenthetical.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml .env.example docs/DEPLOY.md
git commit -m "feat(packaging): scheduler compose service + SCHEDULER_INTERVAL_MS + DEPLOY note"
```

---

### Task 5: Verification gate

Run the full gate honestly and record the numbers. Confirm the scheduler runs end-to-end in the real compose stack (Docker available).

- [ ] **Step 1: Typecheck**

Run: `pnpm -w exec tsc -b` → clean (exit 0).

- [ ] **Step 2: Control-plane lane**

Run: `pnpm --filter @metamodels/control-plane exec vitest run --testTimeout=30000`
Expected: **all green**, control-plane pass count = baseline 167 + the new tests (Task 1: 1, Task 2: 3, Task 3: 3 = **+7 → 174 pass**) + the 3 pre-existing skips (harness + 2 concurrency, still skipped without `PG_TEST_URL`). Record the exact numbers; the intentional `console.error` from Task 2's isolation test is expected output, not a failure.

- [ ] **Step 3: Root lane**

Run: `pnpm test`
Expected: **root 192 pass / 4 skip** — unchanged (no root-lane test was added; `bin/scheduler.ts` has no vitest test). Confirm the env-drift guard is green with `SCHEDULER_INTERVAL_MS` documented.

- [ ] **Step 4: Full-stack smoke incl. the scheduler (Docker available)**

Bring the whole stack up and confirm the scheduler container starts, runs a pass, and stays up:
```bash
cp .env.example .env
docker compose up -d --build
# migrate one-shot completes, apps + scheduler start:
docker compose ps
docker compose logs scheduler
docker compose down -v --remove-orphans
```
Expected: `docker compose ps` shows `scheduler` as `running` (Up); `docker compose logs scheduler` contains `metamodels scheduler: revalidating every` and `revalidation pass: 0/0 ok, 0 failed` (fresh DB has no entitlements → zero LS calls, no network needed). Clean teardown. (Report the literal scheduler log lines. If Docker is unavailable, say so — do not claim the stack ran. `scripts/smoke.sh` itself is unchanged; this is a one-off manual confirmation of the new service.)

- [ ] **Step 5: Report**

State: tsc clean; the exact control-plane (174 pass / 3 skip) and root (192 pass / 4 skip) counts; and the literal scheduler startup/pass log from the compose run (or an explicit note if Docker was unavailable). No commit in this task.

---

## Self-Review

**Spec coverage (roadmap Plan 6c + 5.7b carry-forward):**
- Background re-validation so an entitlement can expire without a login (5.7b carry-forward) → Task 2 (`revalidateAllEntitlements`) + Task 3 (`bin/scheduler.ts` loop). ✓
- Runs as its own scheduler process in `docker compose up` → Task 4 (compose `scheduler` service). ✓ (Structured as a control-plane entrypoint, not `apps/scheduler` — see Global Constraints; the revision was surfaced to and approved by Carmelo.)
- 7-day grace covers the gap between passes → unchanged `revalidateLicense` semantics; the orchestrator only loops it. ✓
- Cadence configurable → `SCHEDULER_INTERVAL_MS` (default 12h), Task 3 + Task 4. ✓
- **Deferred beyond 6c (stated):** due-window filtering (only revalidate entitlements not validated within the interval) — a scale optimization, unnecessary for a single-operator instance; leader election for >1 scheduler instance (run exactly one). Not 6c deliverables. The small still-open items from earlier plans (5.3 template-array RMW `SELECT FOR UPDATE`, `UNIQUE(key_id,paddock_id)`, config-dedup, unify-24h) remain later touches, not 6c scope.

**Placeholder scan:** every step carries complete code or an exact command with expected output. The only judgment call flagged for the implementer is `seedOrg`'s real signature (Task 1 Step 1 note) — resolved by reading `apps/control-plane/src/test/db.ts`, not by weakening the assertion.

**Type/name consistency:** `listEntitledOrgIds(db): Promise<string[]>` (Task 1) is consumed by `revalidateAllEntitlements` (Task 2); `revalidateAllEntitlements(db, deps, revalidate?)` returning `{ total, ok, failed }` (Task 2) is consumed by `bin/scheduler.ts` (Task 3); `resolveIntervalMs(raw)` + `DEFAULT_INTERVAL_MS` (Task 3) match the test and the bin's `process.env.SCHEDULER_INTERVAL_MS` read; `LicenseDeps` (`{ ls, secret, nowMs }`) matches the existing type; the compose `scheduler` service's `SCHEDULER_INTERVAL_MS` matches `.env.example` and the env-drift guard.

**Decisions flagged for the reviewer:** (1) the scheduler is a control-plane `bin/` entrypoint + compose service, NOT `apps/scheduler` — a deliberate, Carmelo-approved revision of the earlier roadmap note, forced by the tsconfig/Next boundary (a standalone tsx app cannot cleanly import the control-plane license modules under `tsc -b`); (2) `revalidateAllEntitlements` takes the per-org revalidate fn as an injected parameter purely to make per-org isolation testable — production always uses the default `revalidateLicense`; (3) `bin/scheduler.ts` has no vitest test (mirrors `apps/worker/src/index.ts` + `bin/seed.ts`) — its meaningful logic is extracted into tested `src/server/*` modules, and it is exercised end-to-end by the Task 3 Step 8 + Task 5 Step 4 live runs.
