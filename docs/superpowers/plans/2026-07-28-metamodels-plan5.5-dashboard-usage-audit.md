# MetaModels Plan 5.5 — Dashboard + Usage + Audit (screens 8a/10a/10b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the three read-only operator screens that surface the data the rest of the system produces — a Dashboard (8a) overview, a Usage (10a) analytics view over `usage_rollup`, and an Audit log (10b) over `audit_log` — org-scoped, capability-gated (`read`), with all aggregation logic in tested, deterministic service modules.

**Architecture:** Two analytical read-services (`usage-service.ts` over `usage_rollup`, `audit-service.ts` over `audit_log`) hold ALL query/aggregation logic and are 100% pglite-tested; they are **deterministic** (time ranges are resolved from an injected `nowMs` in a pure `usage-range.ts` helper — services never call `Date.now()`). The three Next.js server pages read URL `searchParams` for filters, call the services (passing `Date.now()`), and render server-side; thin client components handle filter-select navigation and the audit row expand. No mutations, no new migration, no new dependency — these screens only read tables that Plans 1–5.4 already populate.

**Tech Stack:** TypeScript ESM, Next.js 16.2 (webpack, App Router, RSC + `searchParams`), Drizzle ORM + Postgres (pglite for tests), Vitest. Hand-authored UI primitives (NO chart library, NO shadcn/Radix — supply-chain constraint carried from Plan 5.1).

## Global Constraints

- **Node `>=24`; ESM only.** The Next app does NOT use `.js` import specifiers within its own `src`; shared packages (`@metamodels/schema`) do.
- **No new migration, no new runtime dependency.** These screens read `usage_rollup` (key×paddock×dim×period, populated by the Plan 4 worker) and `audit_log` (written by every control-plane mutation since Plan 5.1). No table changes.
- **Read-only + capability-gated:** every service entry calls `requireCapability(actor, 'read')` and scopes every query to `actor.orgId`. No `writeAudit`, no `db.transaction` (nothing mutates). Viewers can see all three screens (nav items `/`, `/usage`, `/audit` are already `capability: 'read'`).
- **Determinism:** time-range resolution lives in the pure `resolveRange(range, nowMs)` helper; service functions take explicit `startBucket`/`endBucket`/`sinceBucket` strings (never call `Date.now()`), so tests are deterministic. The `usage_rollup.period` format is the hour bucket `YYYY-MM-DDTHH` (from `periodBucket` in `@metamodels/schema`), which is **lexicographically ordered = chronologically ordered** (fixed-width, zero-padded) — so a period range is a plain string `>=`/`<=` comparison, and a day grouping is `substring(period, 1, 10)`.
- **`METER_DIMS`** = `['tokens_in','tokens_out','jobs','gpu_ms','images']` (from `@metamodels/schema`) — the exact five usage dimensions. The headline dim for the dashboard/usage chart and Top Keys is **`tokens_out`**.
- **Data-honesty substitution (dashboard):** the design mock's "Requests 24h" and "Errors 24h" stat tiles have NO backing data (`usage_rollup` records meter dims, not request/error counters; that instrumentation is out of scope). This plan's four tiles are all backed by real org-scoped data: **Flock health** (healthy/total), **Active paddocks** (active/disabled), **API keys** (active count), **Tokens 24h** (rolling sum of `tokens_in`+`tokens_out`). A per-request/per-error rollup is deferred to a later data-plane instrumentation pass.
- **Git identity:** `Carmelo Santana <me@carmelosantana.com>`. Branch: `feat/metamodels-plan5.5`.
- **Test lanes:** root `pnpm test` (baseline 176 pass / 3 skip), control-plane `pnpm --filter @metamodels/control-plane exec vitest run` (baseline 94 pass), workspace typecheck `pnpm -w exec tsc -b`, and `pnpm --filter @metamodels/control-plane exec next build --webpack`. Every task keeps them green.

---

## File Structure

```
apps/control-plane/src/
  lib/
    usage-range.ts                 # CREATE: pure resolveRange(range, nowMs) → {startBucket, endBucket, days[]}
    usage-range.test.ts            # CREATE: range resolution tests
  server/
    usage-service.ts               # CREATE: usageMatrix / dailySeries / topKeys / sumDimSince (org-scoped, deterministic)
    usage-service.test.ts          # CREATE
    audit-service.ts               # CREATE: listAudit / auditFilterOptions (org-scoped)
    audit-service.test.ts          # CREATE
  components/ui/
    stat-tile.tsx                  # CREATE: dashboard StatTile (label, value, sub)
    bar-chart.tsx                  # CREATE: pure-CSS vertical bar chart (no library)
    audit-row.tsx                  # CREATE: expandable audit row (client) + day grouping helper
  app/(app)/
    page.tsx                       # MODIFY: flesh out Dashboard (8a)
    usage/
      page.tsx                     # CREATE: Usage screen (10a) — reads searchParams, calls usage-service
      usage-client.tsx             # CREATE: filter selects (key/paddock/range) + BarChart + matrix table
    audit/
      page.tsx                     # CREATE: Audit screen (10b) — reads searchParams, calls audit-service
      audit-client.tsx             # CREATE: filter selects (action/actor) + day-grouped expandable rows
  README.md                        # MODIFY: document the three screens
```

---

### Task 1: usage-service + range helper (the analytical core)

**Files:**
- Create: `apps/control-plane/src/lib/usage-range.ts`
- Create: `apps/control-plane/src/lib/usage-range.test.ts`
- Create: `apps/control-plane/src/server/usage-service.ts`
- Create: `apps/control-plane/src/server/usage-service.test.ts`

**Interfaces:**
- Consumes: `usageRollup`/`apiKey`/`paddock` tables + `METER_DIMS`/`MeterDim`/`periodBucket` from `@metamodels/schema`; `Db` from `./db`; `requireCapability`/`Actor` from `../auth/authorize`.
- Produces:
  - `usage-range.ts`:
    - `type UsageRange = '24h' | '7d' | '30d'`
    - `interface ResolvedRange { startBucket: string; endBucket: string; days: string[] }`
    - `resolveRange(range: UsageRange, nowMs: number): ResolvedRange` — `days` = list of `YYYY-MM-DD` day-prefixes from the start day to today (UTC), inclusive; count = 1 (24h) / 7 (7d) / 30 (30d). `startBucket = '<firstDay>T00'`, `endBucket = periodBucket(nowMs)`.
    - `isUsageRange(v: string): v is UsageRange`
  - `usage-service.ts`:
    - `interface UsageMatrixRow { keyId: string; keyName: string; keyPrefix: string; paddockId: string; paddockSlug: string; dims: Record<MeterDim, number> }`
    - `interface DailyPoint { day: string; value: number }`
    - `interface TopKeyRow { keyId: string; keyName: string; keyPrefix: string; value: number }`
    - `usageMatrix(db, actor, opts: { startBucket: string; endBucket: string; keyId?: string; paddockId?: string }): Promise<UsageMatrixRow[]>`
    - `dailySeries(db, actor, opts: { dim: MeterDim; startBucket: string; endBucket: string; keyId?: string; paddockId?: string }): Promise<DailyPoint[]>` (sparse — only days with data)
    - `topKeys(db, actor, opts: { dim: MeterDim; startBucket: string; endBucket: string; limit: number }): Promise<TopKeyRow[]>`
    - `sumDimSince(db, actor, dim: MeterDim, sinceBucket: string): Promise<number>`

- [ ] **Step 1: Write the failing range test**

`apps/control-plane/src/lib/usage-range.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import { resolveRange, isUsageRange } from './usage-range'

// 2026-07-28T14:30 UTC
const NOW = Date.UTC(2026, 6, 28, 14, 30, 0)

describe('resolveRange', () => {
  test('7d spans today back six days, endBucket is the current hour', () => {
    const r = resolveRange('7d', NOW)
    expect(r.endBucket).toBe('2026-07-28T14')
    expect(r.startBucket).toBe('2026-07-22T00')
    expect(r.days).toEqual([
      '2026-07-22', '2026-07-23', '2026-07-24', '2026-07-25', '2026-07-26', '2026-07-27', '2026-07-28',
    ])
  })

  test('24h is a single day (today)', () => {
    const r = resolveRange('24h', NOW)
    expect(r.days).toEqual(['2026-07-28'])
    expect(r.startBucket).toBe('2026-07-28T00')
    expect(r.endBucket).toBe('2026-07-28T14')
  })

  test('30d spans 30 day-prefixes ending today', () => {
    const r = resolveRange('30d', NOW)
    expect(r.days).toHaveLength(30)
    expect(r.days[0]).toBe('2026-06-29')
    expect(r.days[29]).toBe('2026-07-28')
  })

  test('isUsageRange guards the union', () => {
    expect(isUsageRange('7d')).toBe(true)
    expect(isUsageRange('year')).toBe(false)
  })
})
```

- [ ] **Step 2: Run it — expect fail**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/lib/usage-range.test.ts`
Expected: FAIL — `Cannot find module './usage-range'`.

- [ ] **Step 3: Implement `usage-range.ts`**

`apps/control-plane/src/lib/usage-range.ts`:
```ts
import { periodBucket } from '@metamodels/schema'

export type UsageRange = '24h' | '7d' | '30d'

export interface ResolvedRange {
  startBucket: string
  endBucket: string
  days: string[] // 'YYYY-MM-DD', start day → today (UTC), inclusive
}

const DAYS: Record<UsageRange, number> = { '24h': 1, '7d': 7, '30d': 30 }
const DAY_MS = 24 * 60 * 60 * 1000

export function isUsageRange(v: string): v is UsageRange {
  return v === '24h' || v === '7d' || v === '30d'
}

/** UTC day-prefix ('YYYY-MM-DD') of a millisecond timestamp. */
function dayPrefix(atMs: number): string {
  return periodBucket(atMs).slice(0, 10)
}

export function resolveRange(range: UsageRange, nowMs: number): ResolvedRange {
  const count = DAYS[range]
  const days: string[] = []
  for (let i = count - 1; i >= 0; i--) days.push(dayPrefix(nowMs - i * DAY_MS))
  return {
    startBucket: `${days[0]}T00`,
    endBucket: periodBucket(nowMs),
    days,
  }
}
```

- [ ] **Step 4: Run it — expect pass**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/lib/usage-range.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing usage-service test**

`apps/control-plane/src/server/usage-service.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import * as schema from '@metamodels/schema'
import { freshDb, seedOrg, type TestDb } from '../test/db'
import { usageMatrix, dailySeries, topKeys, sumDimSince } from './usage-service'
import { type Actor } from '../auth/authorize'

async function actorFor(db: TestDb, role: Actor['role']): Promise<Actor> {
  const o = await seedOrg(db)
  return { id: 'u1', orgId: o.id, email: `${role}@x.io`, role }
}

async function seedKeyPaddock(db: TestDb, orgId: string, keyName: string, slug: string) {
  const [f] = await db.insert(schema.flock).values({ orgId, breed: 'ollama', name: 'f', baseUrl: 'http://f' }).returning()
  const [p] = await db.insert(schema.paddock).values({ orgId, flockId: f.id, slug, name: slug }).returning()
  const [k] = await db.insert(schema.apiKey).values({
    orgId, name: keyName, prefix: `mm_live_${slug}`, hash: `hash_${slug}`, status: 'active',
  }).returning()
  return { paddockId: p.id, keyId: k.id }
}

async function seedRollup(
  db: TestDb, orgId: string, keyId: string, paddockId: string, period: string, dim: string, value: number,
) {
  await db.insert(schema.usageRollup).values({ orgId, keyId, paddockId, period, dim, value })
}

describe('usage-service', () => {
  test('usageMatrix pivots key×paddock rows with all five dims, defaulting missing to 0', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    const { keyId, paddockId } = await seedKeyPaddock(db, actor.orgId, 'Acme', 'chat')
    await seedRollup(db, actor.orgId, keyId, paddockId, '2026-07-25T10', 'tokens_in', 100)
    await seedRollup(db, actor.orgId, keyId, paddockId, '2026-07-25T11', 'tokens_in', 40)
    await seedRollup(db, actor.orgId, keyId, paddockId, '2026-07-25T10', 'tokens_out', 200)

    const rows = await usageMatrix(db, actor, { startBucket: '2026-07-22T00', endBucket: '2026-07-28T23' })
    expect(rows).toHaveLength(1)
    expect(rows[0].keyName).toBe('Acme')
    expect(rows[0].keyPrefix).toBe('mm_live_chat')
    expect(rows[0].paddockSlug).toBe('chat')
    expect(rows[0].dims.tokens_in).toBe(140) // summed across two hour buckets
    expect(rows[0].dims.tokens_out).toBe(200)
    expect(rows[0].dims.jobs).toBe(0)
    expect(rows[0].dims.gpu_ms).toBe(0)
    expect(rows[0].dims.images).toBe(0)
  })

  test('usageMatrix excludes buckets outside the range and other orgs', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    const { keyId, paddockId } = await seedKeyPaddock(db, actor.orgId, 'Acme', 'chat')
    await seedRollup(db, actor.orgId, keyId, paddockId, '2026-07-25T10', 'tokens_in', 100) // in range
    await seedRollup(db, actor.orgId, keyId, paddockId, '2026-07-10T10', 'tokens_in', 999) // before range

    const other = await db.insert(schema.org).values({ name: 'other' }).returning()
    const foreign = await seedKeyPaddock(db, other[0].id, 'Foreign', 'x')
    await seedRollup(db, other[0].id, foreign.keyId, foreign.paddockId, '2026-07-25T10', 'tokens_in', 500)

    const rows = await usageMatrix(db, actor, { startBucket: '2026-07-22T00', endBucket: '2026-07-28T23' })
    expect(rows).toHaveLength(1)
    expect(rows[0].dims.tokens_in).toBe(100)
  })

  test('usageMatrix filters by keyId / paddockId when provided', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    const a = await seedKeyPaddock(db, actor.orgId, 'Acme', 'chat')
    const b = await seedKeyPaddock(db, actor.orgId, 'Beta', 'art')
    await seedRollup(db, actor.orgId, a.keyId, a.paddockId, '2026-07-25T10', 'jobs', 5)
    await seedRollup(db, actor.orgId, b.keyId, b.paddockId, '2026-07-25T10', 'jobs', 9)

    const rows = await usageMatrix(db, actor, { startBucket: '2026-07-22T00', endBucket: '2026-07-28T23', keyId: b.keyId })
    expect(rows).toHaveLength(1)
    expect(rows[0].keyName).toBe('Beta')
    expect(rows[0].dims.jobs).toBe(9)
  })

  test('dailySeries groups a dim by UTC day over the range', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    const { keyId, paddockId } = await seedKeyPaddock(db, actor.orgId, 'Acme', 'chat')
    await seedRollup(db, actor.orgId, keyId, paddockId, '2026-07-25T09', 'tokens_out', 100)
    await seedRollup(db, actor.orgId, keyId, paddockId, '2026-07-25T18', 'tokens_out', 50)
    await seedRollup(db, actor.orgId, keyId, paddockId, '2026-07-26T02', 'tokens_out', 30)
    await seedRollup(db, actor.orgId, keyId, paddockId, '2026-07-26T02', 'tokens_in', 999) // wrong dim, ignored

    const series = await dailySeries(db, actor, { dim: 'tokens_out', startBucket: '2026-07-22T00', endBucket: '2026-07-28T23' })
    expect(series).toEqual([
      { day: '2026-07-25', value: 150 },
      { day: '2026-07-26', value: 30 },
    ])
  })

  test('topKeys ranks keys by summed dim, descending, honoring limit', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    const a = await seedKeyPaddock(db, actor.orgId, 'Acme', 'chat')
    const b = await seedKeyPaddock(db, actor.orgId, 'Beta', 'art')
    await seedRollup(db, actor.orgId, a.keyId, a.paddockId, '2026-07-25T10', 'tokens_out', 100)
    await seedRollup(db, actor.orgId, b.keyId, b.paddockId, '2026-07-25T10', 'tokens_out', 900)
    await seedRollup(db, actor.orgId, b.keyId, b.paddockId, '2026-07-25T11', 'tokens_out', 100)

    const top = await topKeys(db, actor, { dim: 'tokens_out', startBucket: '2026-07-22T00', endBucket: '2026-07-28T23', limit: 5 })
    expect(top.map((k) => [k.keyName, k.value])).toEqual([['Beta', 1000], ['Acme', 100]])
  })

  test('sumDimSince sums one dim from a bucket forward, org-scoped', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    const { keyId, paddockId } = await seedKeyPaddock(db, actor.orgId, 'Acme', 'chat')
    await seedRollup(db, actor.orgId, keyId, paddockId, '2026-07-28T09', 'tokens_out', 10)
    await seedRollup(db, actor.orgId, keyId, paddockId, '2026-07-28T13', 'tokens_out', 5)
    await seedRollup(db, actor.orgId, keyId, paddockId, '2026-07-27T09', 'tokens_out', 999) // before sinceBucket

    const total = await sumDimSince(db, actor, 'tokens_out', '2026-07-28T00')
    expect(total).toBe(15)
  })
})
```

- [ ] **Step 6: Run it — expect fail**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/usage-service.test.ts`
Expected: FAIL — `Cannot find module './usage-service'`.

- [ ] **Step 7: Implement `usage-service.ts`**

`apps/control-plane/src/server/usage-service.ts`:
```ts
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm'
import { apiKey, METER_DIMS, paddock, usageRollup, type MeterDim } from '@metamodels/schema'
import type { Db } from './db'
import { requireCapability, type Actor } from '../auth/authorize'

export interface UsageMatrixRow {
  keyId: string
  keyName: string
  keyPrefix: string
  paddockId: string
  paddockSlug: string
  dims: Record<MeterDim, number>
}

export interface DailyPoint { day: string; value: number }
export interface TopKeyRow { keyId: string; keyName: string; keyPrefix: string; value: number }

const dayExpr = sql<string>`substring(${usageRollup.period} from 1 for 10)`

function zeroDims(): Record<MeterDim, number> {
  return Object.fromEntries(METER_DIMS.map((d) => [d, 0])) as Record<MeterDim, number>
}

export async function usageMatrix(
  db: Db, actor: Actor,
  opts: { startBucket: string; endBucket: string; keyId?: string; paddockId?: string },
): Promise<UsageMatrixRow[]> {
  requireCapability(actor, 'read')
  const conds = [
    eq(usageRollup.orgId, actor.orgId),
    gte(usageRollup.period, opts.startBucket),
    lte(usageRollup.period, opts.endBucket),
  ]
  if (opts.keyId) conds.push(eq(usageRollup.keyId, opts.keyId))
  if (opts.paddockId) conds.push(eq(usageRollup.paddockId, opts.paddockId))

  const rows = await db
    .select({
      keyId: usageRollup.keyId,
      keyName: apiKey.name,
      keyPrefix: apiKey.prefix,
      paddockId: usageRollup.paddockId,
      paddockSlug: paddock.slug,
      dim: usageRollup.dim,
      total: sql<number>`sum(${usageRollup.value})`,
    })
    .from(usageRollup)
    .innerJoin(apiKey, eq(apiKey.id, usageRollup.keyId))
    .innerJoin(paddock, eq(paddock.id, usageRollup.paddockId))
    .where(and(...conds))
    .groupBy(usageRollup.keyId, apiKey.name, apiKey.prefix, usageRollup.paddockId, paddock.slug, usageRollup.dim)

  // Pivot (keyId,paddockId) → dims. Deterministic order: keyName then paddockSlug.
  const byPair = new Map<string, UsageMatrixRow>()
  for (const r of rows) {
    const mapKey = `${r.keyId}|${r.paddockId}`
    let row = byPair.get(mapKey)
    if (!row) {
      row = {
        keyId: r.keyId, keyName: r.keyName, keyPrefix: r.keyPrefix,
        paddockId: r.paddockId, paddockSlug: r.paddockSlug, dims: zeroDims(),
      }
      byPair.set(mapKey, row)
    }
    if ((METER_DIMS as readonly string[]).includes(r.dim)) row.dims[r.dim as MeterDim] = Number(r.total)
  }
  return [...byPair.values()].sort(
    (a, b) => a.keyName.localeCompare(b.keyName) || a.paddockSlug.localeCompare(b.paddockSlug),
  )
}

export async function dailySeries(
  db: Db, actor: Actor,
  opts: { dim: MeterDim; startBucket: string; endBucket: string; keyId?: string; paddockId?: string },
): Promise<DailyPoint[]> {
  requireCapability(actor, 'read')
  const conds = [
    eq(usageRollup.orgId, actor.orgId),
    eq(usageRollup.dim, opts.dim),
    gte(usageRollup.period, opts.startBucket),
    lte(usageRollup.period, opts.endBucket),
  ]
  if (opts.keyId) conds.push(eq(usageRollup.keyId, opts.keyId))
  if (opts.paddockId) conds.push(eq(usageRollup.paddockId, opts.paddockId))

  const rows = await db
    .select({ day: dayExpr, total: sql<number>`sum(${usageRollup.value})` })
    .from(usageRollup)
    .where(and(...conds))
    .groupBy(dayExpr)
    .orderBy(dayExpr)
  return rows.map((r) => ({ day: r.day, value: Number(r.total) }))
}

export async function topKeys(
  db: Db, actor: Actor,
  opts: { dim: MeterDim; startBucket: string; endBucket: string; limit: number },
): Promise<TopKeyRow[]> {
  requireCapability(actor, 'read')
  const rows = await db
    .select({
      keyId: usageRollup.keyId,
      keyName: apiKey.name,
      keyPrefix: apiKey.prefix,
      total: sql<number>`sum(${usageRollup.value})`,
    })
    .from(usageRollup)
    .innerJoin(apiKey, eq(apiKey.id, usageRollup.keyId))
    .where(and(
      eq(usageRollup.orgId, actor.orgId),
      eq(usageRollup.dim, opts.dim),
      gte(usageRollup.period, opts.startBucket),
      lte(usageRollup.period, opts.endBucket),
    ))
    .groupBy(usageRollup.keyId, apiKey.name, apiKey.prefix)
    .orderBy(desc(sql`sum(${usageRollup.value})`))
    .limit(opts.limit)
  return rows.map((r) => ({ keyId: r.keyId, keyName: r.keyName, keyPrefix: r.keyPrefix, value: Number(r.total) }))
}

export async function sumDimSince(
  db: Db, actor: Actor, dim: MeterDim, sinceBucket: string,
): Promise<number> {
  requireCapability(actor, 'read')
  const rows = await db
    .select({ total: sql<number>`coalesce(sum(${usageRollup.value}), 0)` })
    .from(usageRollup)
    .where(and(
      eq(usageRollup.orgId, actor.orgId),
      eq(usageRollup.dim, dim),
      gte(usageRollup.period, sinceBucket),
    ))
  return Number(rows[0]?.total ?? 0)
}
```

- [ ] **Step 8: Run it — expect pass**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/usage-service.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 9: Typecheck + control-plane suite**

Run: `pnpm -w exec tsc -b`
Expected: clean.

Run: `pnpm --filter @metamodels/control-plane exec vitest run`
Expected: 104 pass (94 + 4 range + 6 usage).

- [ ] **Step 10: Commit**

```bash
git add apps/control-plane/src/lib/usage-range.ts apps/control-plane/src/lib/usage-range.test.ts apps/control-plane/src/server/usage-service.ts apps/control-plane/src/server/usage-service.test.ts
git commit -m "feat(control-plane): usage-service + range helper — org-scoped usage aggregation"
```

---

### Task 2: audit-service (read side)

**Files:**
- Create: `apps/control-plane/src/server/audit-service.ts`
- Create: `apps/control-plane/src/server/audit-service.test.ts`

**Interfaces:**
- Consumes: `auditLog` table from `@metamodels/schema`; `Db`; `requireCapability`/`Actor`.
- Produces:
  - `interface AuditRow { id: string; createdAt: Date; actor: string; action: string; target: string; detail: unknown }`
  - `listAudit(db, actor, opts: { action?: string; auditActor?: string; limit: number }): Promise<AuditRow[]>` — org-scoped, newest-first (`createdAt` desc).
  - `auditFilterOptions(db, actor): Promise<{ actions: string[]; actors: string[] }>` — distinct values, org-scoped, sorted ascending.

Note: the existing `apps/control-plane/src/server/audit.ts` owns the WRITE side (`writeAudit`). Keep that file unchanged; this is a separate read module (different responsibility → different file).

- [ ] **Step 1: Write the failing test**

`apps/control-plane/src/server/audit-service.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import * as schema from '@metamodels/schema'
import { freshDb, seedOrg, type TestDb } from '../test/db'
import { listAudit, auditFilterOptions } from './audit-service'
import { ForbiddenError, type Actor } from '../auth/authorize'

async function actorFor(db: TestDb, role: Actor['role']): Promise<Actor> {
  const o = await seedOrg(db)
  return { id: 'u1', orgId: o.id, email: `${role}@x.io`, role }
}

async function seedAudit(db: TestDb, orgId: string, actor: string, action: string, target: string, detail?: unknown) {
  await db.insert(schema.auditLog).values({ orgId, actor, action, target, detail: (detail ?? null) as never })
}

describe('audit-service', () => {
  test('listAudit returns this org newest-first, honoring limit', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    await seedAudit(db, actor.orgId, 'carmelo@x.io', 'flock.create', 'flock:1')
    await seedAudit(db, actor.orgId, 'carmelo@x.io', 'key.create', 'key:2', { name: 'Acme' })
    await seedAudit(db, actor.orgId, 'carmelo@x.io', 'key.revoke', 'key:2')

    const rows = await listAudit(db, actor, { limit: 2 })
    expect(rows).toHaveLength(2)
    expect(rows[0].action).toBe('key.revoke') // newest first
    expect(rows[1].action).toBe('key.create')
    expect(rows[1].detail).toEqual({ name: 'Acme' })
  })

  test('listAudit is org-scoped (no cross-org leak) and filters by action + actor', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    await seedAudit(db, actor.orgId, 'carmelo@x.io', 'flock.create', 'flock:1')
    await seedAudit(db, actor.orgId, 'jo@x.io', 'key.create', 'key:2')
    const [other] = await db.insert(schema.org).values({ name: 'other' }).returning()
    await seedAudit(db, other.id, 'spy@x.io', 'flock.create', 'flock:9')

    expect(await listAudit(db, actor, { limit: 50 })).toHaveLength(2) // not the foreign row
    const byAction = await listAudit(db, actor, { limit: 50, action: 'key.create' })
    expect(byAction.map((r) => r.action)).toEqual(['key.create'])
    const byActor = await listAudit(db, actor, { limit: 50, auditActor: 'jo@x.io' })
    expect(byActor.map((r) => r.actor)).toEqual(['jo@x.io'])
  })

  test('auditFilterOptions returns distinct sorted actions + actors for this org', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    await seedAudit(db, actor.orgId, 'carmelo@x.io', 'key.revoke', 'key:2')
    await seedAudit(db, actor.orgId, 'carmelo@x.io', 'flock.create', 'flock:1')
    await seedAudit(db, actor.orgId, 'jo@x.io', 'flock.create', 'flock:3')
    const [other] = await db.insert(schema.org).values({ name: 'other' }).returning()
    await seedAudit(db, other.id, 'spy@x.io', 'paddock.create', 'paddock:9')

    const opts = await auditFilterOptions(db, actor)
    expect(opts.actions).toEqual(['flock.create', 'key.revoke'])
    expect(opts.actors).toEqual(['carmelo@x.io', 'jo@x.io'])
  })

  test('viewer can read the audit log', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'viewer')
    await seedAudit(db, actor.orgId, 'carmelo@x.io', 'flock.create', 'flock:1')
    expect(await listAudit(db, actor, { limit: 10 })).toHaveLength(1)
  })

  test('a non-read role is rejected', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const noRead = { id: 'u1', orgId: o.id, email: 'x@x.io', role: 'viewer' as const }
    // sanity: viewer HAS read; assert the capability gate exists by calling requireCapability path via a bad role cast
    const bad = { ...noRead, role: 'nobody' as unknown as Actor['role'] }
    await expect(listAudit(db, bad, { limit: 10 })).rejects.toThrow(ForbiddenError)
  })
})
```

- [ ] **Step 2: Run it — expect fail**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/audit-service.test.ts`
Expected: FAIL — `Cannot find module './audit-service'`.

- [ ] **Step 3: Implement `audit-service.ts`**

`apps/control-plane/src/server/audit-service.ts`:
```ts
import { and, desc, eq } from 'drizzle-orm'
import { auditLog } from '@metamodels/schema'
import type { Db } from './db'
import { requireCapability, type Actor } from '../auth/authorize'

export interface AuditRow {
  id: string
  createdAt: Date
  actor: string
  action: string
  target: string
  detail: unknown
}

export async function listAudit(
  db: Db, actor: Actor, opts: { action?: string; auditActor?: string; limit: number },
): Promise<AuditRow[]> {
  requireCapability(actor, 'read')
  const conds = [eq(auditLog.orgId, actor.orgId)]
  if (opts.action) conds.push(eq(auditLog.action, opts.action))
  if (opts.auditActor) conds.push(eq(auditLog.actor, opts.auditActor))

  const rows = await db
    .select({
      id: auditLog.id, createdAt: auditLog.createdAt, actor: auditLog.actor,
      action: auditLog.action, target: auditLog.target, detail: auditLog.detail,
    })
    .from(auditLog)
    .where(and(...conds))
    .orderBy(desc(auditLog.createdAt))
    .limit(opts.limit)
  return rows.map((r) => ({ ...r, detail: r.detail as unknown }))
}

export async function auditFilterOptions(
  db: Db, actor: Actor,
): Promise<{ actions: string[]; actors: string[] }> {
  requireCapability(actor, 'read')
  const rows = await db
    .select({ action: auditLog.action, actor: auditLog.actor })
    .from(auditLog)
    .where(eq(auditLog.orgId, actor.orgId))
  const actions = [...new Set(rows.map((r) => r.action))].sort()
  const actors = [...new Set(rows.map((r) => r.actor))].sort()
  return { actions, actors }
}
```

- [ ] **Step 4: Run it — expect pass**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/audit-service.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck + control-plane suite**

Run: `pnpm -w exec tsc -b`
Expected: clean.

Run: `pnpm --filter @metamodels/control-plane exec vitest run`
Expected: 109 pass (104 + 5).

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane/src/server/audit-service.ts apps/control-plane/src/server/audit-service.test.ts
git commit -m "feat(control-plane): audit-service — org-scoped audit read + filter options"
```

---

### Task 3: Usage screen (10a)

**Files:**
- Create: `apps/control-plane/src/components/ui/bar-chart.tsx`
- Create: `apps/control-plane/src/app/(app)/usage/page.tsx`
- Create: `apps/control-plane/src/app/(app)/usage/usage-client.tsx`

**Interfaces:**
- Consumes: `usageMatrix`/`dailySeries` + `resolveRange`/`isUsageRange`/`UsageRange` (Task 1); `listKeys` from `../../../server/keys-service` (filter options); `listPaddocks` from `../../../server/paddocks-service` (filter options); `requireUser`/`getDb`; `METER_DIMS`/`MeterDim`.
- Produces: the `/usage` screen. `BarChart` is a reusable pure-CSS component.

- [ ] **Step 1: Create the BarChart component**

`apps/control-plane/src/components/ui/bar-chart.tsx`:
```tsx
export interface Bar { label: string; value: number; highlight?: boolean }

/** Pure-CSS vertical bar chart (no chart library). Bars scale to the max value. */
export function BarChart({ bars, height = 160 }: { bars: Bar[]; height?: number }) {
  const max = Math.max(1, ...bars.map((b) => b.value))
  return (
    <div className="flex items-end gap-2" style={{ height }}>
      {bars.map((b, i) => (
        <div key={i} className="flex flex-1 flex-col items-center justify-end gap-1">
          <div
            className={b.highlight ? 'w-full rounded-t-sm bg-[var(--color-comfyui)]' : 'w-full rounded-t-sm bg-[var(--color-primary)]'}
            style={{ height: `${(b.value / max) * 100}%` }}
            title={`${b.label}: ${b.value.toLocaleString()}`}
          />
          <span className="text-[10px] text-[var(--color-muted)]">{b.label}</span>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Create the server page**

`apps/control-plane/src/app/(app)/usage/page.tsx`:
```tsx
import { getDb } from '../../../server/db'
import { requireUser } from '../../../server/guard'
import { usageMatrix, dailySeries } from '../../../server/usage-service'
import { listKeys } from '../../../server/keys-service'
import { listPaddocks } from '../../../server/paddocks-service'
import { resolveRange, isUsageRange } from '../../../lib/usage-range'
import { UsageClient } from './usage-client'

const HEADLINE = 'tokens_out' as const

export default async function UsagePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const actor = await requireUser()
  const db = getDb()

  const rangeParam = typeof sp.range === 'string' && isUsageRange(sp.range) ? sp.range : '7d'
  const keyId = typeof sp.key === 'string' && sp.key ? sp.key : undefined
  const paddockId = typeof sp.paddock === 'string' && sp.paddock ? sp.paddock : undefined
  const { startBucket, endBucket, days } = resolveRange(rangeParam, Date.now())

  const [matrix, series, keys, paddocks] = await Promise.all([
    usageMatrix(db, actor, { startBucket, endBucket, keyId, paddockId }),
    dailySeries(db, actor, { dim: HEADLINE, startBucket, endBucket, keyId, paddockId }),
    listKeys(db, actor),
    listPaddocks(db, actor),
  ])

  // Fill every day in the range (dailySeries is sparse).
  const byDay = new Map(series.map((p) => [p.day, p.value]))
  const bars = days.map((d) => ({ label: d.slice(5), value: byDay.get(d) ?? 0 })) // label = MM-DD
  const total = bars.reduce((s, b) => s + b.value, 0)

  return (
    <UsageClient
      range={rangeParam}
      keyId={keyId ?? ''}
      paddockId={paddockId ?? ''}
      bars={bars}
      total={total}
      rows={matrix}
      keys={keys.map((k) => ({ id: k.id, name: k.name }))}
      paddocks={paddocks.map((p) => ({ id: p.id, slug: p.slug }))}
    />
  )
}
```

- [ ] **Step 3: Create the client**

`apps/control-plane/src/app/(app)/usage/usage-client.tsx`:
```tsx
'use client'
import { useRouter } from 'next/navigation'
import { METER_DIMS, type MeterDim } from '@metamodels/schema'
import { PageHeader } from '../../../components/page-header'
import { DataTable } from '../../../components/ui/data-table'
import { Select } from '../../../components/ui/select'
import { BarChart } from '../../../components/ui/bar-chart'
import type { UsageRange } from '../../../lib/usage-range'
import type { UsageMatrixRow } from '../../../server/usage-service'

interface Opt { id: string; label: string }

export function UsageClient(props: {
  range: UsageRange; keyId: string; paddockId: string
  bars: { label: string; value: number }[]; total: number
  rows: UsageMatrixRow[]
  keys: { id: string; name: string }[]
  paddocks: { id: string; slug: string }[]
}) {
  const router = useRouter()

  function apply(next: Partial<{ key: string; paddock: string; range: string }>) {
    const params = new URLSearchParams()
    const key = next.key ?? props.keyId
    const paddock = next.paddock ?? props.paddockId
    const range = next.range ?? props.range
    if (key) params.set('key', key)
    if (paddock) params.set('paddock', paddock)
    params.set('range', range)
    router.push(`/usage?${params.toString()}`)
  }

  const num = (n: number) => (n === 0 ? '—' : n.toLocaleString())

  return (
    <div>
      <PageHeader
        title="Usage"
        actions={
          <div className="flex gap-2">
            <Select aria-label="Key" value={props.keyId} onChange={(e) => apply({ key: e.target.value })}>
              <option value="">All keys</option>
              {props.keys.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
            </Select>
            <Select aria-label="Paddock" value={props.paddockId} onChange={(e) => apply({ paddock: e.target.value })}>
              <option value="">All paddocks</option>
              {props.paddocks.map((p) => <option key={p.id} value={p.id}>/p/{p.slug}</option>)}
            </Select>
            <Select aria-label="Range" value={props.range} onChange={(e) => apply({ range: e.target.value })}>
              <option value="24h">Last 24h</option>
              <option value="7d">Last 7d</option>
              <option value="30d">Last 30d</option>
            </Select>
          </div>
        }
      />

      <div className="mb-6 rounded-[var(--radius-control)] border border-[var(--color-border)] p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <span className="text-sm text-[var(--color-text)]">tokens_out · last {props.range}</span>
          <span className="font-mono text-sm text-[var(--color-primary)]">{props.total.toLocaleString()} total</span>
        </div>
        <BarChart bars={props.bars} />
      </div>

      <DataTable headers={['Key', 'Paddock', ...METER_DIMS.map((d) => d as string)]}>
        {props.rows.map((r) => (
          <tr key={`${r.keyId}|${r.paddockId}`} className="border-b border-[var(--color-divider)]">
            <td className="px-3 py-2 text-[var(--color-text)]">{r.keyName}</td>
            <td className="px-3 py-2 font-mono text-xs text-[var(--color-muted)]">/p/{r.paddockSlug}</td>
            {METER_DIMS.map((d) => (
              <td key={d} className="px-3 py-2 text-right font-mono text-xs text-[var(--color-text)]">{num(r.dims[d as MeterDim])}</td>
            ))}
          </tr>
        ))}
        {props.rows.length === 0 && (
          <tr><td colSpan={2 + METER_DIMS.length} className="px-3 py-8 text-center text-[var(--color-muted)]">No usage recorded in this range.</td></tr>
        )}
      </DataTable>
    </div>
  )
}
```

- [ ] **Step 4: Verify — the Select component supports `value`/`onChange`**

Read `apps/control-plane/src/components/ui/select.tsx`. Confirm it forwards standard `<select>` props (`value`, `onChange`, `aria-label`) — the Flocks screen uses `<Select name=... defaultValue=...>`, so it forwards props. If it does NOT spread `...props`, adjust the calls to whatever prop API it exposes (do not change the component's contract for other callers). Expected: it spreads props; no change needed.

- [ ] **Step 5: Typecheck + build + suite**

Run: `pnpm -w exec tsc -b`
Expected: clean.

Run: `pnpm --filter @metamodels/control-plane exec vitest run`
Expected: 109 pass (UI adds no unit tests).

Run: `pnpm --filter @metamodels/control-plane exec next build --webpack`
Expected: build succeeds; route list includes `/usage`.

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane/src/components/ui/bar-chart.tsx apps/control-plane/src/app/\(app\)/usage
git commit -m "feat(control-plane): screen 10a — Usage (tokens_out chart + key×paddock×dim matrix, filters)"
```

---

### Task 4: Audit screen (10b)

**Files:**
- Create: `apps/control-plane/src/components/ui/audit-row.tsx`
- Create: `apps/control-plane/src/app/(app)/audit/page.tsx`
- Create: `apps/control-plane/src/app/(app)/audit/audit-client.tsx`

**Interfaces:**
- Consumes: `listAudit`/`auditFilterOptions` + `AuditRow` (Task 2); `requireUser`/`getDb`.
- Produces: the `/audit` screen. `AuditRow` is an expandable client row.

- [ ] **Step 1: Create the AuditRowItem component**

`apps/control-plane/src/components/ui/audit-row.tsx`:
```tsx
'use client'
import { useState } from 'react'
import { cn } from './cn'

export interface AuditRowData {
  id: string
  createdAtISO: string
  actor: string
  action: string
  target: string
  detail: unknown
}

/** Colour the status dot: destructive verbs red, health amber, else primary. */
function dotClass(action: string): string {
  if (/revoke|delete|disable/.test(action)) return 'bg-[var(--color-danger)]'
  if (/health/.test(action)) return 'bg-[var(--color-comfyui)]'
  return 'bg-[var(--color-primary)]'
}

/** verb from a dotted action id, e.g. 'key.revoke' → 'revoke'. */
function verb(action: string): string {
  const i = action.indexOf('.')
  return i >= 0 ? action.slice(i + 1) : action
}

export function AuditRowItem({ row }: { row: AuditRowData }) {
  const [open, setOpen] = useState(false)
  const time = row.createdAtISO.slice(11, 16) // HH:MM (UTC)
  const hasDetail = row.detail != null && typeof row.detail === 'object'

  return (
    <div className="border-b border-[var(--color-divider)]">
      <button
        type="button"
        onClick={() => hasDetail && setOpen((v) => !v)}
        className="flex w-full items-center gap-4 px-3 py-2 text-left"
      >
        <span className="w-12 font-mono text-xs text-[var(--color-muted)]">{time}</span>
        <span className={cn('h-2 w-2 shrink-0 rounded-full', dotClass(row.action))} />
        <span className="w-24 font-mono text-xs text-[var(--color-text)]">{verb(row.action)}</span>
        <span className="flex-1 text-sm text-[var(--color-muted)]">{row.target}</span>
        <span className="text-xs text-[var(--color-muted)]">{row.actor}</span>
        {hasDetail && <span className="text-xs text-[var(--color-faint)]">{open ? '▾' : '▸'}</span>}
      </button>
      {open && hasDetail && (
        <pre className="mx-3 mb-2 overflow-x-auto rounded-[var(--radius-control)] bg-[var(--color-panel-2)] p-3 font-mono text-xs text-[var(--color-muted)]">
          {JSON.stringify(row.detail, null, 2)}
        </pre>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Create the server page**

`apps/control-plane/src/app/(app)/audit/page.tsx`:
```tsx
import { getDb } from '../../../server/db'
import { requireUser } from '../../../server/guard'
import { listAudit, auditFilterOptions } from '../../../server/audit-service'
import { AuditClient } from './audit-client'

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const actor = await requireUser()
  const db = getDb()

  const action = typeof sp.action === 'string' && sp.action ? sp.action : undefined
  const auditActor = typeof sp.actor === 'string' && sp.actor ? sp.actor : undefined

  const [rows, options] = await Promise.all([
    listAudit(db, actor, { action, auditActor, limit: 200 }),
    auditFilterOptions(db, actor),
  ])

  return (
    <AuditClient
      action={action ?? ''}
      actor={auditActor ?? ''}
      options={options}
      rows={rows.map((r) => ({
        id: r.id, createdAtISO: r.createdAt.toISOString(), actor: r.actor,
        action: r.action, target: r.target, detail: r.detail,
      }))}
    />
  )
}
```

- [ ] **Step 3: Create the client**

`apps/control-plane/src/app/(app)/audit/audit-client.tsx`:
```tsx
'use client'
import { useRouter } from 'next/navigation'
import { PageHeader } from '../../../components/page-header'
import { Select } from '../../../components/ui/select'
import { AuditRowItem, type AuditRowData } from '../../../components/ui/audit-row'

/** Group label for a day: Today / Yesterday / weekday+date, from the row's UTC date. */
function dayLabel(iso: string, now: Date): string {
  const d = new Date(iso)
  const today = now.toISOString().slice(0, 10)
  const y = new Date(now.getTime() - 86400000).toISOString().slice(0, 10)
  const day = iso.slice(0, 10)
  if (day === today) return 'Today'
  if (day === y) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

export function AuditClient(props: {
  action: string; actor: string
  options: { actions: string[]; actors: string[] }
  rows: AuditRowData[]
}) {
  const router = useRouter()
  const now = new Date()

  function apply(next: Partial<{ action: string; actor: string }>) {
    const params = new URLSearchParams()
    const action = next.action ?? props.action
    const actor = next.actor ?? props.actor
    if (action) params.set('action', action)
    if (actor) params.set('actor', actor)
    const qs = params.toString()
    router.push(qs ? `/audit?${qs}` : '/audit')
  }

  // Group consecutive rows (already newest-first) by day label.
  const groups: { label: string; rows: AuditRowData[] }[] = []
  for (const row of props.rows) {
    const label = dayLabel(row.createdAtISO, now)
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.rows.push(row)
    else groups.push({ label, rows: [row] })
  }

  return (
    <div>
      <PageHeader
        title="Audit log"
        actions={
          <div className="flex gap-2">
            <Select aria-label="Action" value={props.action} onChange={(e) => apply({ action: e.target.value })}>
              <option value="">All actions</option>
              {props.options.actions.map((a) => <option key={a} value={a}>{a}</option>)}
            </Select>
            <Select aria-label="Actor" value={props.actor} onChange={(e) => apply({ actor: e.target.value })}>
              <option value="">All actors</option>
              {props.options.actors.map((a) => <option key={a} value={a}>{a}</option>)}
            </Select>
          </div>
        }
      />

      {groups.map((g) => (
        <div key={g.label} className="mb-4">
          <div className="mb-1 px-3 text-xs uppercase tracking-wide text-[var(--color-faint)]">{g.label}</div>
          {g.rows.map((row) => <AuditRowItem key={row.id} row={row} />)}
        </div>
      ))}
      {props.rows.length === 0 && (
        <div className="px-3 py-8 text-center text-[var(--color-muted)]">No audit events match these filters.</div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Typecheck + build + suite**

Run: `pnpm -w exec tsc -b`
Expected: clean.

Run: `pnpm --filter @metamodels/control-plane exec vitest run`
Expected: 109 pass.

Run: `pnpm --filter @metamodels/control-plane exec next build --webpack`
Expected: build succeeds; route list includes `/audit`.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/components/ui/audit-row.tsx apps/control-plane/src/app/\(app\)/audit
git commit -m "feat(control-plane): screen 10b — Audit log (day-grouped, filterable, expandable detail)"
```

---

### Task 5: Dashboard (8a)

**Files:**
- Create: `apps/control-plane/src/components/ui/stat-tile.tsx`
- Modify: `apps/control-plane/src/app/(app)/page.tsx`
- Modify: `apps/control-plane/README.md`

**Interfaces:**
- Consumes: `StatTile` (new); `listFlocks` from `../../server/flocks-service`; `listPaddocks` from `../../server/paddocks-service`; `listKeys` from `../../server/keys-service`; `topKeys`/`sumDimSince` from `../../server/usage-service`; `listAudit` from `../../server/audit-service`; `AuditRowItem` from `../../components/ui/audit-row`; `periodBucket` from `@metamodels/schema`; `requireUser`/`getDb`.
- Produces: the Dashboard at `/`.

- [ ] **Step 1: Create the StatTile component**

`apps/control-plane/src/components/ui/stat-tile.tsx`:
```tsx
import type { ReactNode } from 'react'

/** Dashboard overview tile: an uppercase label, a large value, and an optional sub-line/visual. */
export function StatTile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rounded-[var(--radius-control)] border border-[var(--color-border)] p-4">
      <div className="mb-2 text-xs uppercase tracking-wide text-[var(--color-muted)]">{label}</div>
      <div className="text-3xl font-semibold text-[var(--color-text)]">{value}</div>
      {sub && <div className="mt-2 text-xs text-[var(--color-muted)]">{sub}</div>}
    </div>
  )
}
```

- [ ] **Step 2: Rewrite the Dashboard page**

Replace `apps/control-plane/src/app/(app)/page.tsx` entirely:
```tsx
import Link from 'next/link'
import { periodBucket } from '@metamodels/schema'
import { getDb } from '../../server/db'
import { requireUser } from '../../server/guard'
import { listFlocks } from '../../server/flocks-service'
import { listPaddocks } from '../../server/paddocks-service'
import { listKeys } from '../../server/keys-service'
import { topKeys, sumDimSince } from '../../server/usage-service'
import { listAudit } from '../../server/audit-service'
import { PageHeader } from '../../components/page-header'
import { StatTile } from '../../components/ui/stat-tile'
import { DataTable } from '../../components/ui/data-table'
import { BreedChip } from '../../components/ui/breed-chip'
import { StatusPill } from '../../components/ui/status-pill'
import { AuditRowItem } from '../../components/ui/audit-row'

const DAY_MS = 24 * 60 * 60 * 1000

export default async function DashboardPage() {
  const actor = await requireUser()
  const db = getDb()
  const now = Date.now()
  const since24h = periodBucket(now - DAY_MS)

  const [flocks, paddocks, keys, top, tokensIn24h, tokensOut24h, recent] = await Promise.all([
    listFlocks(db, actor),
    listPaddocks(db, actor),
    listKeys(db, actor),
    topKeys(db, actor, { dim: 'tokens_out', startBucket: since24h, endBucket: periodBucket(now), limit: 5 }),
    sumDimSince(db, actor, 'tokens_in', since24h),
    sumDimSince(db, actor, 'tokens_out', since24h),
    listAudit(db, actor, { limit: 8 }),
  ])

  const healthyFlocks = flocks.filter((f) => f.healthOk === true).length
  const activePaddocks = paddocks.filter((p) => p.status === 'active').length
  const disabledPaddocks = paddocks.length - activePaddocks
  const activeKeys = keys.filter((k) => k.status === 'active').length
  const tokens24h = tokensIn24h + tokensOut24h
  const topMax = Math.max(1, ...top.map((t) => t.value))

  return (
    <div>
      <PageHeader title="Dashboard" subtitle={`Signed in as ${actor.email}`} />

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Flock health" value={`${healthyFlocks}/${flocks.length}`} sub={flocks.length ? 'healthy servers' : 'no flocks yet'} />
        <StatTile label="Active paddocks" value={activePaddocks} sub={disabledPaddocks ? `${disabledPaddocks} disabled` : 'all active'} />
        <StatTile label="API keys" value={activeKeys} sub={`${keys.length} total`} />
        <StatTile label="Tokens · 24h" value={tokens24h.toLocaleString()} sub="tokens_in + tokens_out" />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-[var(--radius-control)] border border-[var(--color-border)] p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <span className="text-sm font-medium text-[var(--color-text)]">Flocks</span>
            <Link href="/flocks" className="text-xs text-[var(--color-primary)] hover:underline">View all →</Link>
          </div>
          <DataTable headers={['Name', 'Breed', 'Base URL', 'Health']}>
            {flocks.map((f) => (
              <tr key={f.id} className="border-b border-[var(--color-divider)]">
                <td className="px-3 py-2 text-[var(--color-text)]">{f.name}</td>
                <td className="px-3 py-2"><BreedChip breed={f.breed} /></td>
                <td className="px-3 py-2 font-mono text-xs text-[var(--color-muted)]">{f.baseUrl}</td>
                <td className="px-3 py-2"><StatusPill ok={f.healthOk} /></td>
              </tr>
            ))}
            {flocks.length === 0 && (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-[var(--color-muted)]">No flocks connected.</td></tr>
            )}
          </DataTable>

          <div className="mt-4">
            <div className="mb-2 text-sm font-medium text-[var(--color-text)]">Top keys · 24h</div>
            {top.length === 0 && <div className="text-xs text-[var(--color-muted)]">No usage in the last 24h.</div>}
            {top.map((t) => (
              <div key={t.keyId} className="flex items-center gap-3 py-1">
                <span className="w-40 truncate font-mono text-xs text-[var(--color-muted)]">{t.keyPrefix}…</span>
                <span className="flex-1 text-xs text-[var(--color-text)]">{t.keyName}</span>
                <span className="w-20 text-right font-mono text-xs text-[var(--color-text)]">{t.value.toLocaleString()}</span>
                <span className="h-2 w-24 overflow-hidden rounded-full bg-[var(--color-panel-2)]">
                  <span className="block h-full bg-[var(--color-primary)]" style={{ width: `${(t.value / topMax) * 100}%` }} />
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-[var(--radius-control)] border border-[var(--color-border)] p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <span className="text-sm font-medium text-[var(--color-text)]">Recent activity</span>
            <Link href="/audit" className="text-xs text-[var(--color-primary)] hover:underline">audit →</Link>
          </div>
          {recent.length === 0 && <div className="text-xs text-[var(--color-muted)]">No activity yet.</div>}
          {recent.map((r) => (
            <AuditRowItem key={r.id} row={{
              id: r.id, createdAtISO: r.createdAt.toISOString(), actor: r.actor,
              action: r.action, target: r.target, detail: r.detail,
            }} />
          ))}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Document the screens in the README**

In `apps/control-plane/README.md`, add three lines to the Screens list (mirroring existing entries):
```markdown
- **Dashboard** (`/`) — at-a-glance tiles (flock health, active paddocks, API keys, tokens/24h), a Flocks summary with Top keys, and recent audit activity.
- **Usage** (`/usage`) — a `tokens_out` bar chart over the selected range and a key×paddock×dimension matrix, filterable by key/paddock/range.
- **Audit log** (`/audit`) — day-grouped, filterable (action/actor) audit events with expandable detail.
```

- [ ] **Step 4: Typecheck + build + suites**

Run: `pnpm -w exec tsc -b`
Expected: clean.

Run: `pnpm --filter @metamodels/control-plane exec next build --webpack`
Expected: build succeeds; route list includes `/`, `/usage`, `/audit`.

Run: `pnpm --filter @metamodels/control-plane exec vitest run`
Expected: 109 pass.

Run: `pnpm test`
Expected: root 176 pass / 3 skip (unchanged — the new tests live in the control-plane lane, not the root lane).

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/components/ui/stat-tile.tsx apps/control-plane/src/app/\(app\)/page.tsx apps/control-plane/README.md
git commit -m "feat(control-plane): screen 8a — Dashboard (stat tiles, Flocks + Top keys, recent activity)"
```

---

## Self-Review

**Spec coverage:**
- Screen 8a Dashboard — StatTile ×4, Flocks table, Top keys, Recent activity → Task 5. ✓ (Requests/Errors tiles substituted with real-data tiles per the data-honesty constraint.)
- Screen 10a Usage — key/paddock/range filters, `tokens_out` bar chart, key×paddock×dim matrix → Task 3. ✓
- Screen 10b Audit — action/actor filters, day-group headers, expandable rows with detail card → Task 4. ✓
- Reads `usage_rollup` (Task 1 service) + `audit_log` (Task 2 service), org-scoped, capability-gated `read`. ✓
- Read-only, no migration, no new dependency. ✓

**Placeholder scan:** every code step carries complete code; every run step has an exact command + expected output. No TBD/TODO. ✓

**Type consistency:** `UsageMatrixRow`/`DailyPoint`/`TopKeyRow`/`AuditRow`/`AuditRowData`/`ResolvedRange`/`UsageRange`, and the service signatures (`usageMatrix`/`dailySeries`/`topKeys`/`sumDimSince`/`listAudit`/`auditFilterOptions`) are used consistently across tasks. `resolveRange`/`isUsageRange` and `periodBucket` used per Task-1 definitions. The audit page maps `createdAt: Date → createdAtISO: string` for the serializable client boundary; `MeterDim`/`METER_DIMS` from the schema package throughout. The `opts.auditActor` param name (not `actor`, to avoid colliding with the `Actor` concept) is consistent between `audit-service.ts` and its callers. ✓

**Deviations flagged for the reviewer / carry-forward:** the dashboard "Requests 24h"/"Errors 24h" tiles are replaced by "API keys"/"Tokens 24h" (no request/error rollup exists — deferred to a data-plane instrumentation pass); `dailySeries` returns a sparse series filled to the full day-axis in the page; day-group labels in the audit UI use the viewer's `toLocaleDateString` with `timeZone: 'UTC'` (grouping is by UTC day, matching the stored `createdAt`).
