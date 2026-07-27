# MetaModels Plan 4 — Worker, Durable Rollups, Redis Infra & Quota Caps

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make usage durable and enforceable — a Redis-stream–decoupled worker aggregates meter events into `usage_rollup` (idempotent per bucket), the JobStore and rate limiter become correct across instances (Postgres atomic CAS + Redis atomic sliding-window), and Fences gain hard quota caps read back from the rollups.

**Architecture:** The data-plane hot path stays fast — `MeterSink.emit` becomes an `XADD` to a durable Redis stream instead of an in-memory push. A new `apps/worker` process consumes that stream in a consumer group and upserts each event into `usage_rollup` via `INSERT … ON CONFLICT (org_id,key_id,paddock_id,period,dim) DO UPDATE SET value = value + excluded.value`, then `XACK`s. Jobs move to a Postgres `job` table whose `markMetered` is a real `UPDATE … WHERE metered = false RETURNING` compare-and-set. Rate limiting moves to a Redis ZSET sliding-window driven by one atomic Lua script. Quota caps are enforced in the request path by reading the current period's rollup total and rejecting at/over the cap. Every new backend keeps the existing interface (`MeterSink` / `RateLimiter` / `JobStore`), so the in-memory implementations remain the test doubles and only `server.ts` wiring changes for production.

**Tech Stack:** TypeScript (ESM, NodeNext), Hono, Drizzle ORM + Postgres 16 (`postgres` driver; `@electric-sql/pglite` for Docker-free tests), **ioredis** (Redis client) + **ioredis-mock** (Docker-free Redis tests), Zod, Vitest, pnpm workspaces.

## Global Constraints

- **Node floor:** `engines.node >= 24`; `.nvmrc` = `24`. Do not lower.
- **Supply chain:** `.npmrc` enforces `minimumReleaseAge=1440` and `blockExoticSubdeps=true`. New deps must be mature registry packages older than 24h — **pin exact versions (no `^`)** for the Redis deps: `ioredis@5.4.2`, `ioredis-mock@8.9.0`. Do not add native/build-script deps (both chosen packages are pure JS — no `allowBuilds` entry needed).
- **Tests stay Docker-free.** Postgres pieces are tested against `pglite` (real migrations). Redis pieces are tested against `ioredis-mock`. Any test that genuinely needs a real Redis feature `ioredis-mock` can't emulate must be gated `test.skipIf(!process.env.REDIS_TEST_URL)` — never left failing — and the correctness of the underlying logic must ALSO be covered by a pure/pglite test that does not touch Redis. Full real-Redis integration is Plan 6.
- **Interfaces are the seam.** `MeterSink`, `RateLimiter`, `JobStore` interfaces are frozen — new backends implement them verbatim. Existing app/proxy tests keep injecting the in-memory doubles; do not change their wiring.
- **ESM import paths:** intra-package relative imports use the `.js` extension (e.g. `./aggregator.js`); cross-package imports use the workspace name (`@metamodels/schema`, `@metamodels/connectors`).
- **Migrations are additive.** Drizzle migrations are append-only; introduce new tables/indexes as a new numbered migration, never by editing `0000_*`.
- **Commit discipline:** one commit per task (or per green sub-cycle), conventional-commit messages. Git identity `Carmelo Santana <me@carmelosantana.com>`, working branch `feat/metamodels-plan4`.

---

## File structure (Plan 4)

```
packages/schema/
  src/
    schema.ts                     # MODIFY: add `job` table; add composite uniqueIndex to usage_rollup
    period.ts                     # CREATE: periodBucket() / periodPrefix() pure helpers
    stream.ts                     # CREATE: meter-stream key/group constants + encode/decode wire codec
    index.ts                      # MODIFY: re-export ./period.js and ./stream.js
  drizzle/
    0001_*.sql                    # CREATE (generated): job table + usage_rollup unique index
apps/data-plane/
  src/
    jobs/postgres-job-store.ts    # CREATE: PostgresJobStore (atomic CAS markMetered)
    meter/redis-meter-sink.ts     # CREATE: RedisMeterSink (XADD producer)
    meter/usage-reader.ts         # CREATE: UsageReader interface + DrizzleUsageReader
    ratelimit/redis-rate-limiter.ts # CREATE: RedisRateLimiter (atomic Lua sliding-window)
    config/quota.ts               # CREATE: quota zod schema + QuotaRule type
    app.ts                        # MODIFY: add quota gate; add /healthz + optional readiness route dep
    server.ts                     # MODIFY: env-driven Redis vs in-memory wiring; Postgres job store; readiness
  test/
    postgres-job-store.test.ts    # CREATE
    redis-meter-sink.test.ts      # CREATE
    redis-rate-limiter.test.ts    # CREATE
    quota.integration.test.ts     # CREATE
    healthz.test.ts               # CREATE
    server-config.test.ts         # MODIFY: REDIS_URL parsing
apps/worker/                      # CREATE: new package
  package.json
  tsconfig.json
  src/
    aggregator.ts                 # applyEvents(): upsert rollups
    consumer.ts                   # ensureGroup(), readBatch(), ackBatch()
    worker.ts                     # processOnce(): read→apply→ack
    index.ts                      # entrypoint: connect + loop
  test/
    aggregator.test.ts            # CREATE (pglite)
    worker.test.ts                # CREATE (ioredis-mock + pglite; skipIf fallback)
tsconfig.json                     # MODIFY: add { path: apps/worker } reference
```

**Interfaces produced by this plan (referenced across tasks):**

- `periodBucket(atMs: number): string` → `'YYYY-MM-DDTHH'` (UTC). `periodPrefix(win: 'hour'|'day'|'month', atMs: number): string`. Type `QuotaWindow = 'hour'|'day'|'month'`. (Task 2, `@metamodels/schema`)
- `METER_STREAM_KEY`, `METER_GROUP` constants; `MeterStreamEvent` interface; `encodeMeterEvent(e): Record<string,string>`; `decodeMeterEvent(fields: string[]): MeterStreamEvent`. (Task 5, `@metamodels/schema`)
- `PostgresJobStore` implements `JobStore` from `@metamodels/connectors`. (Task 3)
- `RollupEvent { orgId, keyId, paddockId, dim, value, at }`; `applyEvents(db, events): Promise<void>`. (Task 4, `@metamodels/worker`)
- `RedisMeterSink` implements `MeterSink`. (Task 5)
- `processOnce(redis, db, consumer): Promise<number>`. (Task 6)
- `RedisRateLimiter` implements `RateLimiter`. (Task 7)
- `quotaSchema` (zod, `z.array(quotaRuleSchema)`); `QuotaRule { dim: MeterDim; max: number; period: QuotaWindow }`; `UsageReader.periodUsage(keyId, paddockId, dim, win, atMs): Promise<number>`; `DrizzleUsageReader`. (Task 8)

---

## Pre-flight (run once, not a task)

Confirm the starting point before Task 1:

```bash
git checkout main && git pull --ff-only 2>/dev/null; git checkout -b feat/metamodels-plan4
pnpm install
pnpm test   # expect: all green (baseline before Plan 4)
```

---

### Task 1: Schema — `job` table + `usage_rollup` composite unique index + migration

**Files:**
- Modify: `packages/schema/src/schema.ts`
- Create (generated): `packages/schema/drizzle/0001_*.sql`
- Test: `packages/schema/test/schema.test.ts` (add cases)

**Interfaces:**
- Consumes: existing `org`, `apiKey`, `paddock`, `usageRollup` tables.
- Produces: `job` pgTable; a UNIQUE index `usage_rollup_key` on `(org_id, key_id, paddock_id, period, dim)`.

- [ ] **Step 1: Write the failing test** — add to `packages/schema/test/schema.test.ts`:

```ts
import { and, eq, sql } from 'drizzle-orm'
// ...existing imports (makeDb/migrate helper or PGlite+drizzle+migrate as the file already does)...

test('usage_rollup rejects a duplicate (org,key,paddock,period,dim) row', async () => {
  const db = await freshMigratedDb() // reuse this file's existing migrate helper
  const [org] = await db.insert(schema.org).values({ name: 'o' }).returning()
  const [flock] = await db.insert(schema.flock).values({ orgId: org.id, breed: 'ollama', name: 'f', baseUrl: 'http://x' }).returning()
  const [pad] = await db.insert(schema.paddock).values({ orgId: org.id, flockId: flock.id, slug: 's1', name: 'p' }).returning()
  const [key] = await db.insert(schema.apiKey).values({ orgId: org.id, name: 'k', prefix: 'mm_live_x', hash: 'h1' }).returning()
  const row = { orgId: org.id, keyId: key.id, paddockId: pad.id, period: '2026-07-27T14', dim: 'tokens_out', value: 1 }
  await db.insert(schema.usageRollup).values(row)
  await expect(db.insert(schema.usageRollup).values(row)).rejects.toThrow()
})

test('job table stores and reads a record', async () => {
  const db = await freshMigratedDb()
  const [org] = await db.insert(schema.org).values({ name: 'o' }).returning()
  const [flock] = await db.insert(schema.flock).values({ orgId: org.id, breed: 'comfyui', name: 'f', baseUrl: 'http://x' }).returning()
  const [pad] = await db.insert(schema.paddock).values({ orgId: org.id, flockId: flock.id, slug: 's2', name: 'p' }).returning()
  const [key] = await db.insert(schema.apiKey).values({ orgId: org.id, name: 'k', prefix: 'mm_live_y', hash: 'h2' }).returning()
  await db.insert(schema.job).values({
    id: 'prompt-1', orgId: org.id, keyId: key.id, paddockId: pad.id,
    templateId: 'tpl-a', cost: 3, submittedAt: new Date(1000),
  })
  const rows = await db.select().from(schema.job).where(eq(schema.job.id, 'prompt-1'))
  expect(rows[0]).toMatchObject({ id: 'prompt-1', templateId: 'tpl-a', cost: 3, metered: false })
})
```

> If `schema.test.ts` doesn't already expose a `freshMigratedDb()` helper, inline the existing PGlite+drizzle+`migrate({ migrationsFolder })` setup this file already uses at the top of each test (match the file's current pattern).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/schema/test/schema.test.ts`
Expected: FAIL — `schema.job` is undefined / no unique constraint (duplicate insert resolves).

- [ ] **Step 3: Modify the schema** — in `packages/schema/src/schema.ts`:

Add `uniqueIndex` to the drizzle import:

```ts
import { boolean, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
```

Add the composite unique index to `usageRollup` by giving `pgTable` its second (extras) argument. Replace the existing `usageRollup` definition's closing with:

```ts
export const usageRollup = pgTable('usage_rollup', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  keyId: uuid('key_id').notNull().references(() => apiKey.id, { onDelete: 'cascade' }),
  paddockId: uuid('paddock_id').notNull().references(() => paddock.id, { onDelete: 'cascade' }),
  period: text('period').notNull(),
  dim: text('dim').notNull(),
  value: integer('value').notNull().default(0),
}, (t) => [
  uniqueIndex('usage_rollup_key').on(t.orgId, t.keyId, t.paddockId, t.period, t.dim),
])
```

Add the `job` table (place it after `usageRollup`, before `auditLog`):

```ts
export const job = pgTable('job', {
  id: text('id').primaryKey(), // upstream job/prompt id (e.g. ComfyUI prompt_id)
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  keyId: uuid('key_id').notNull().references(() => apiKey.id, { onDelete: 'cascade' }),
  paddockId: uuid('paddock_id').notNull().references(() => paddock.id, { onDelete: 'cascade' }),
  templateId: text('template_id').notNull(), // fence-declared template id (NOT a DB FK)
  cost: integer('cost').notNull().default(1),
  metered: boolean('metered').notNull().default(false),
  submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull(),
})
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm --filter @metamodels/schema db:generate`
Expected: a new file `packages/schema/drizzle/0001_<random>.sql` is created containing `CREATE TABLE "job" (…)` and `CREATE UNIQUE INDEX "usage_rollup_key" ON "usage_rollup" (…)`, and `drizzle/meta/` is updated. Open the `.sql` and confirm those two statements are present.

> If `db:generate` cannot run in this environment, hand-write `packages/schema/drizzle/0001_plan4.sql` with exactly:
> ```sql
> CREATE TABLE "job" (
>   "id" text PRIMARY KEY NOT NULL,
>   "org_id" uuid NOT NULL,
>   "key_id" uuid NOT NULL,
>   "paddock_id" uuid NOT NULL,
>   "template_id" text NOT NULL,
>   "cost" integer DEFAULT 1 NOT NULL,
>   "metered" boolean DEFAULT false NOT NULL,
>   "submitted_at" timestamp with time zone NOT NULL
> );
> --> statement-breakpoint
> ALTER TABLE "job" ADD CONSTRAINT "job_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
> ALTER TABLE "job" ADD CONSTRAINT "job_key_id_api_key_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_key"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
> ALTER TABLE "job" ADD CONSTRAINT "job_paddock_id_paddock_id_fk" FOREIGN KEY ("paddock_id") REFERENCES "public"."paddock"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
> CREATE UNIQUE INDEX "usage_rollup_key" ON "usage_rollup" USING btree ("org_id","key_id","paddock_id","period","dim");
> ```
> and add a matching snapshot only if drizzle-kit tooling is available; otherwise prefer the generated route. The pglite migrator applies raw `.sql` regardless of the snapshot, so the tests will pass either way.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run packages/schema/test/schema.test.ts`
Expected: PASS (both new cases + all pre-existing schema cases).

- [ ] **Step 6: Full typecheck + suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/schema/src/schema.ts packages/schema/drizzle packages/schema/test/schema.test.ts
git commit -m "feat(schema): job table + usage_rollup composite unique index (Plan 4)"
```

---

### Task 2: `periodBucket` / `periodPrefix` pure helpers

**Files:**
- Create: `packages/schema/src/period.ts`
- Modify: `packages/schema/src/index.ts`
- Test: `packages/schema/test/period.test.ts`

**Interfaces:**
- Produces: `periodBucket(atMs: number): string`; `periodPrefix(win: QuotaWindow, atMs: number): string`; `type QuotaWindow = 'hour' | 'day' | 'month'`.

- [ ] **Step 1: Write the failing test** — `packages/schema/test/period.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { periodBucket, periodPrefix } from '../src/period.js'

const T = Date.UTC(2026, 6, 27, 14, 37, 5) // 2026-07-27T14:37:05Z (month is 0-based)

describe('periodBucket', () => {
  test('formats a UTC hour bucket YYYY-MM-DDTHH', () => {
    expect(periodBucket(T)).toBe('2026-07-27T14')
  })
  test('zero-pads single-digit month/day/hour', () => {
    expect(periodBucket(Date.UTC(2026, 0, 3, 5))).toBe('2026-01-03T05')
  })
})

describe('periodPrefix', () => {
  test('hour → full bucket', () => { expect(periodPrefix('hour', T)).toBe('2026-07-27T14') })
  test('day → date only', () => { expect(periodPrefix('day', T)).toBe('2026-07-27') })
  test('month → year-month', () => { expect(periodPrefix('month', T)).toBe('2026-07') })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/schema/test/period.test.ts`
Expected: FAIL — module `../src/period.js` not found.

- [ ] **Step 3: Implement** — `packages/schema/src/period.ts`:

```ts
export type QuotaWindow = 'hour' | 'day' | 'month'

/** UTC hour bucket, e.g. `2026-07-27T14`. The canonical `usage_rollup.period` format. */
export function periodBucket(atMs: number): string {
  const d = new Date(atMs)
  const y = d.getUTCFullYear()
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0')
  const da = String(d.getUTCDate()).padStart(2, '0')
  const h = String(d.getUTCHours()).padStart(2, '0')
  return `${y}-${mo}-${da}T${h}`
}

/** Prefix of the hour bucket used for `period LIKE prefix || '%'` quota range reads. */
export function periodPrefix(win: QuotaWindow, atMs: number): string {
  const bucket = periodBucket(atMs)
  if (win === 'hour') return bucket
  if (win === 'day') return bucket.slice(0, 10) // YYYY-MM-DD
  return bucket.slice(0, 7) // YYYY-MM
}
```

- [ ] **Step 4: Re-export** — add to `packages/schema/src/index.ts`:

```ts
export * from './period.js'
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm vitest run packages/schema/test/period.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/schema/src/period.ts packages/schema/src/index.ts packages/schema/test/period.test.ts
git commit -m "feat(schema): period bucket/prefix helpers for rollups + quota windows"
```

---

### Task 3: `PostgresJobStore` with atomic CAS `markMetered`

**Files:**
- Create: `apps/data-plane/src/jobs/postgres-job-store.ts`
- Test: `apps/data-plane/test/postgres-job-store.test.ts`

**Interfaces:**
- Consumes: `JobRecord`, `JobStore` from `@metamodels/connectors`; `job` table (Task 1); `makeDb`/`seedFixture` from `apps/data-plane/test/helpers/seed.ts` (test only).
- Produces: `class PostgresJobStore implements JobStore`.

- [ ] **Step 1: Write the failing test** — `apps/data-plane/test/postgres-job-store.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import type { JobRecord } from '@metamodels/connectors'
import { PostgresJobStore } from '../src/jobs/postgres-job-store.js'
import { makeDb, seedFixture } from './helpers/seed.js'

async function storeWithScope() {
  const db = await makeDb()
  const fx = await seedFixture(db) // gives real orgId/keyId/paddockId (FK-valid)
  return { store: new PostgresJobStore(db), fx }
}

function sample(fx: { orgId: string; keyId: string; paddockId: string }): Omit<JobRecord, 'metered'> {
  return { jobId: 'job-1', orgId: fx.orgId, keyId: fx.keyId, paddockId: fx.paddockId, templateId: 't', cost: 5, submittedAt: 100 }
}

describe('PostgresJobStore', () => {
  test('create then get round-trips the record with metered:false', async () => {
    const { store, fx } = await storeWithScope()
    const created = await store.create(sample(fx))
    expect(created).toEqual({ ...sample(fx), metered: false })
    expect(await store.get('job-1')).toEqual({ ...sample(fx), metered: false })
  })

  test('get of an unknown id returns null', async () => {
    const { store } = await storeWithScope()
    expect(await store.get('nope')).toBeNull()
  })

  test('markMetered is a compare-and-set: true once, false thereafter', async () => {
    const { store, fx } = await storeWithScope()
    await store.create(sample(fx))
    expect(await store.markMetered('job-1')).toBe(true)
    expect(await store.markMetered('job-1')).toBe(false)
    expect((await store.get('job-1'))!.metered).toBe(true)
  })

  test('markMetered on unknown id returns false', async () => {
    const { store } = await storeWithScope()
    expect(await store.markMetered('nope')).toBe(false)
  })

  test('concurrent markMetered: exactly one caller wins', async () => {
    const { store, fx } = await storeWithScope()
    await store.create(sample(fx))
    const results = await Promise.all([store.markMetered('job-1'), store.markMetered('job-1'), store.markMetered('job-1')])
    expect(results.filter((r) => r === true)).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run apps/data-plane/test/postgres-job-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `apps/data-plane/src/jobs/postgres-job-store.ts`:

```ts
import { and, eq } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { job } from '@metamodels/schema'
import type { JobRecord, JobStore } from '@metamodels/connectors'

type Db = PgDatabase<any, any, any>

/**
 * Durable {@link JobStore} backed by the Postgres `job` table.
 *
 * `markMetered` is a real cross-instance compare-and-set: a single
 * `UPDATE … WHERE metered = false RETURNING id` — the database guarantees only
 * one concurrent updater sees `metered = false`, so exactly one caller gets a
 * non-empty result set and meters the side effects.
 */
export class PostgresJobStore implements JobStore {
  constructor(private readonly db: Db) {}

  async create(rec: Omit<JobRecord, 'metered'>): Promise<JobRecord> {
    await this.db.insert(job).values({
      id: rec.jobId,
      orgId: rec.orgId,
      keyId: rec.keyId,
      paddockId: rec.paddockId,
      templateId: rec.templateId,
      cost: rec.cost,
      metered: false,
      submittedAt: new Date(rec.submittedAt),
    })
    return { ...rec, metered: false }
  }

  async get(jobId: string): Promise<JobRecord | null> {
    const rows = await this.db.select().from(job).where(eq(job.id, jobId)).limit(1)
    const r = rows[0]
    if (!r) return null
    return {
      jobId: r.id,
      orgId: r.orgId,
      keyId: r.keyId,
      paddockId: r.paddockId,
      templateId: r.templateId,
      cost: r.cost,
      metered: r.metered,
      submittedAt: r.submittedAt.getTime(),
    }
  }

  async markMetered(jobId: string): Promise<boolean> {
    const rows = await this.db
      .update(job)
      .set({ metered: true })
      .where(and(eq(job.id, jobId), eq(job.metered, false)))
      .returning({ id: job.id })
    return rows.length > 0
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run apps/data-plane/test/postgres-job-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/data-plane/src/jobs/postgres-job-store.ts apps/data-plane/test/postgres-job-store.test.ts
git commit -m "feat(data-plane): PostgresJobStore with atomic CAS markMetered"
```

---

### Task 4: `apps/worker` package + `applyEvents` rollup upsert

**Files:**
- Create: `apps/worker/package.json`, `apps/worker/tsconfig.json`, `apps/worker/src/aggregator.ts`
- Modify: root `tsconfig.json` (add reference)
- Test: `apps/worker/test/aggregator.test.ts`

**Interfaces:**
- Consumes: `usageRollup`, `periodBucket`, `MeterDim` from `@metamodels/schema`.
- Produces: `interface RollupEvent { orgId; keyId; paddockId; dim: MeterDim; value: number; at: number }`; `applyEvents(db, events: RollupEvent[]): Promise<void>`.

- [ ] **Step 1: Scaffold the package** — `apps/worker/package.json`:

```json
{
  "name": "@metamodels/worker",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "start": "tsx src/index.ts" },
  "dependencies": {
    "@metamodels/schema": "workspace:*",
    "drizzle-orm": "^0.45.2",
    "ioredis": "5.4.2",
    "postgres": "^3.4.0"
  },
  "devDependencies": {
    "@electric-sql/pglite": "^0.5.4",
    "ioredis-mock": "8.9.0",
    "tsx": "^4.19.0"
  }
}
```

`apps/worker/tsconfig.json` (mirror `apps/data-plane/tsconfig.json` — read it first and copy its `compilerOptions`, adjusting only paths/references):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "references": [{ "path": "../../packages/schema" }],
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

> Read `apps/data-plane/tsconfig.json` and match its exact shape (module/moduleResolution etc. come from `tsconfig.base.json`). Then add the reference to root `tsconfig.json`:

```json
{
  "files": [],
  "references": [
    { "path": "packages/schema" },
    { "path": "packages/connectors" },
    { "path": "apps/data-plane" },
    { "path": "apps/worker" }
  ]
}
```

- [ ] **Step 2: Install the new deps**

Run: `pnpm install`
Expected: `ioredis@5.4.2` and `ioredis-mock@8.9.0` resolve and install (both predate the 24h `minimumReleaseAge` window; no build scripts).

- [ ] **Step 3: Write the failing test** — `apps/worker/test/aggregator.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { and, eq } from 'drizzle-orm'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as schema from '@metamodels/schema'
import { applyEvents, type RollupEvent } from '../src/aggregator.js'

async function freshDb() {
  const db = drizzle(new PGlite(), { schema })
  const here = dirname(fileURLToPath(import.meta.url))
  await migrate(db, { migrationsFolder: resolve(here, '../../../packages/schema/drizzle') })
  return db
}

async function scope(db: Awaited<ReturnType<typeof freshDb>>) {
  const [org] = await db.insert(schema.org).values({ name: 'o' }).returning()
  const [flock] = await db.insert(schema.flock).values({ orgId: org.id, breed: 'ollama', name: 'f', baseUrl: 'http://x' }).returning()
  const [pad] = await db.insert(schema.paddock).values({ orgId: org.id, flockId: flock.id, slug: 's', name: 'p' }).returning()
  const [key] = await db.insert(schema.apiKey).values({ orgId: org.id, name: 'k', prefix: 'mm_live_z', hash: 'h' }).returning()
  return { orgId: org.id, keyId: key.id, paddockId: pad.id }
}

const AT = Date.UTC(2026, 6, 27, 14, 30) // 2026-07-27T14

describe('applyEvents', () => {
  test('inserts a new rollup row for a fresh bucket', async () => {
    const db = await freshDb(); const s = await scope(db)
    await applyEvents(db, [{ ...s, dim: 'tokens_out', value: 7, at: AT }])
    const rows = await db.select().from(schema.usageRollup)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ period: '2026-07-27T14', dim: 'tokens_out', value: 7 })
  })

  test('accumulates value into the same bucket (idempotent upsert)', async () => {
    const db = await freshDb(); const s = await scope(db)
    const e: RollupEvent = { ...s, dim: 'tokens_out', value: 4, at: AT }
    await applyEvents(db, [e])
    await applyEvents(db, [{ ...e, value: 6 }])
    const rows = await db.select().from(schema.usageRollup)
      .where(and(eq(schema.usageRollup.keyId, s.keyId), eq(schema.usageRollup.dim, 'tokens_out')))
    expect(rows).toHaveLength(1)
    expect(rows[0].value).toBe(10)
  })

  test('separate dims and hour buckets are distinct rows', async () => {
    const db = await freshDb(); const s = await scope(db)
    await applyEvents(db, [
      { ...s, dim: 'tokens_out', value: 1, at: AT },
      { ...s, dim: 'tokens_in', value: 2, at: AT },
      { ...s, dim: 'tokens_out', value: 3, at: AT + 3_600_000 }, // next hour
    ])
    const rows = await db.select().from(schema.usageRollup)
    expect(rows).toHaveLength(3)
  })
})
```

- [ ] **Step 4: Run to verify it fails**

Run: `pnpm vitest run apps/worker/test/aggregator.test.ts`
Expected: FAIL — `../src/aggregator.js` not found.

- [ ] **Step 5: Implement** — `apps/worker/src/aggregator.ts`:

```ts
import { sql } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { periodBucket, usageRollup, type MeterDim } from '@metamodels/schema'

export interface RollupEvent {
  orgId: string
  keyId: string
  paddockId: string
  dim: MeterDim
  value: number
  at: number
}

type Db = PgDatabase<any, any, any>

/**
 * Upsert a batch of meter events into `usage_rollup`, summing into the
 * hour bucket derived from each event's `at`. The composite UNIQUE index
 * `usage_rollup_key` makes the ON CONFLICT target additive rather than a
 * read-modify-write race. Wrapped in a transaction so a batch is all-or-nothing.
 */
export async function applyEvents(db: Db, events: RollupEvent[]): Promise<void> {
  if (events.length === 0) return
  await db.transaction(async (tx) => {
    for (const e of events) {
      await tx
        .insert(usageRollup)
        .values({
          orgId: e.orgId,
          keyId: e.keyId,
          paddockId: e.paddockId,
          period: periodBucket(e.at),
          dim: e.dim,
          value: e.value,
        })
        .onConflictDoUpdate({
          target: [usageRollup.orgId, usageRollup.keyId, usageRollup.paddockId, usageRollup.period, usageRollup.dim],
          set: { value: sql`${usageRollup.value} + ${e.value}` },
        })
    }
  })
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm vitest run apps/worker/test/aggregator.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck the whole workspace**

Run: `pnpm typecheck`
Expected: PASS (new `apps/worker` project reference compiles).

- [ ] **Step 8: Commit**

```bash
git add apps/worker/package.json apps/worker/tsconfig.json apps/worker/src/aggregator.ts apps/worker/test/aggregator.test.ts tsconfig.json pnpm-lock.yaml
git commit -m "feat(worker): apps/worker package + applyEvents rollup upsert"
```

---

### Task 5: Meter stream wire codec + `RedisMeterSink` producer

**Files:**
- Create: `packages/schema/src/stream.ts`
- Modify: `packages/schema/src/index.ts`
- Create: `apps/data-plane/src/meter/redis-meter-sink.ts`
- Test: `packages/schema/test/stream.test.ts`, `apps/data-plane/test/redis-meter-sink.test.ts`

**Interfaces:**
- Consumes: `MeterSink`, `MeterEventRecord` from `apps/data-plane/src/meter/meter-sink.ts`.
- Produces: `METER_STREAM_KEY`, `METER_GROUP`, `MeterStreamEvent`, `encodeMeterEvent`, `decodeMeterEvent` (in `@metamodels/schema`); `class RedisMeterSink implements MeterSink`.

- [ ] **Step 1: Write the codec test** — `packages/schema/test/stream.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { decodeMeterEvent, encodeMeterEvent, type MeterStreamEvent } from '../src/stream.js'

const ev: MeterStreamEvent = {
  orgId: 'o', keyId: 'k', paddockId: 'p', breedId: 'ollama', dim: 'tokens_out', value: 42, at: 1000,
}

describe('meter stream codec', () => {
  test('encode → XADD field map with a single json `data` field', () => {
    const fields = encodeMeterEvent(ev)
    expect(fields).toEqual({ data: JSON.stringify(ev) })
  })
  test('decode reverses encode from a flat [field, value, ...] array', () => {
    const { data } = encodeMeterEvent(ev)
    expect(decodeMeterEvent(['data', data])).toEqual(ev)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/schema/test/stream.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the codec** — `packages/schema/src/stream.ts`:

```ts
/** Redis stream key the data-plane XADDs meter events to and the worker consumes. */
export const METER_STREAM_KEY = 'metamodels:meters'
/** Consumer group name the worker reads under. */
export const METER_GROUP = 'rollup'

export interface MeterStreamEvent {
  orgId: string
  keyId: string
  paddockId: string
  breedId: string
  dim: string
  value: number
  at: number
}

/** Encode an event as a single-field XADD map: `{ data: <json> }`. */
export function encodeMeterEvent(e: MeterStreamEvent): Record<string, string> {
  return { data: JSON.stringify(e) }
}

/** Decode a flat `[field, value, field, value, …]` XREADGROUP field array back to an event. */
export function decodeMeterEvent(fields: string[]): MeterStreamEvent {
  const i = fields.indexOf('data')
  if (i < 0 || i + 1 >= fields.length) throw new Error('meter stream entry missing `data` field')
  return JSON.parse(fields[i + 1]) as MeterStreamEvent
}
```

Add to `packages/schema/src/index.ts`:

```ts
export * from './stream.js'
```

- [ ] **Step 4: Run the codec test**

Run: `pnpm vitest run packages/schema/test/stream.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the producer test** — `apps/data-plane/test/redis-meter-sink.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import RedisMock from 'ioredis-mock'
import { decodeMeterEvent, METER_STREAM_KEY } from '@metamodels/schema'
import { RedisMeterSink } from '../src/meter/redis-meter-sink.js'
import type { MeterEventRecord } from '../src/meter/meter-sink.js'

function rec(dim: MeterEventRecord['dim'], value: number): MeterEventRecord {
  return { orgId: 'o', keyId: 'k', paddockId: 'p', breedId: 'ollama', dim, value, at: 1000 }
}

describe('RedisMeterSink', () => {
  test('emit XADDs one stream entry per event', async () => {
    const redis = new RedisMock()
    const sink = new RedisMeterSink(redis as any)
    await sink.emit([rec('tokens_in', 3), rec('tokens_out', 5)])
    expect(await redis.xlen(METER_STREAM_KEY)).toBe(2)
  })

  test('the XADDed entries decode back to the original events', async () => {
    const redis = new RedisMock()
    const sink = new RedisMeterSink(redis as any)
    await sink.emit([rec('tokens_out', 5)])
    const entries = await redis.xrange(METER_STREAM_KEY, '-', '+')
    // entries: [ [id, [field, value, ...]], ... ]
    const decoded = decodeMeterEvent(entries[0][1])
    expect(decoded).toMatchObject({ dim: 'tokens_out', value: 5, keyId: 'k' })
  })

  test('emit of an empty array is a no-op', async () => {
    const redis = new RedisMock()
    const sink = new RedisMeterSink(redis as any)
    await sink.emit([])
    expect(await redis.xlen(METER_STREAM_KEY)).toBe(0)
  })
})
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm vitest run apps/data-plane/test/redis-meter-sink.test.ts`
Expected: FAIL — `../src/meter/redis-meter-sink.js` not found.

- [ ] **Step 7: Implement the producer** — `apps/data-plane/src/meter/redis-meter-sink.ts`:

```ts
import type { Redis } from 'ioredis'
import { encodeMeterEvent, METER_STREAM_KEY } from '@metamodels/schema'
import type { MeterEventRecord, MeterSink } from './meter-sink.js'

/**
 * Durable {@link MeterSink} that XADDs each meter event to a Redis stream on the
 * hot path (fast, fire-and-forget from the request's perspective; the caller
 * already runs this best-effort + drained). The `apps/worker` consumer group
 * aggregates the stream into `usage_rollup`. `MAXLEN ~` caps unbounded growth.
 */
export class RedisMeterSink implements MeterSink {
  constructor(
    private readonly redis: Redis,
    private readonly maxLen = 100_000,
  ) {}

  async emit(events: MeterEventRecord[]): Promise<void> {
    if (events.length === 0) return
    const pipe = this.redis.pipeline()
    for (const e of events) {
      const { data } = encodeMeterEvent(e)
      pipe.xadd(METER_STREAM_KEY, 'MAXLEN', '~', String(this.maxLen), '*', 'data', data)
    }
    await pipe.exec()
  }
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `pnpm vitest run apps/data-plane/test/redis-meter-sink.test.ts`
Expected: PASS.

> If `ioredis-mock`'s `pipeline().xadd(...).exec()` mis-handles the `MAXLEN ~` args, fall back to awaiting each `redis.xadd(...)` in a loop (same commands, no pipeline) — behavior is identical for the test. Keep the pipeline for production if it works.

- [ ] **Step 9: Commit**

```bash
git add packages/schema/src/stream.ts packages/schema/src/index.ts packages/schema/test/stream.test.ts apps/data-plane/src/meter/redis-meter-sink.ts apps/data-plane/test/redis-meter-sink.test.ts
git commit -m "feat: meter-stream codec + RedisMeterSink XADD producer"
```

---

### Task 6: Worker consumer loop (`consumer.ts` + `worker.ts` + entrypoint)

**Files:**
- Create: `apps/worker/src/consumer.ts`, `apps/worker/src/worker.ts`, `apps/worker/src/index.ts`
- Test: `apps/worker/test/worker.test.ts`

**Interfaces:**
- Consumes: `applyEvents`, `RollupEvent` (Task 4); `METER_STREAM_KEY`, `METER_GROUP`, `decodeMeterEvent` (Task 5).
- Produces: `ensureGroup(redis)`; `readBatch(redis, consumer, count, blockMs)`; `ackBatch(redis, ids)`; `processOnce(redis, db, consumer): Promise<number>`.

- [ ] **Step 1: Write the failing test** — `apps/worker/test/worker.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import RedisMock from 'ioredis-mock'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as schema from '@metamodels/schema'
import { encodeMeterEvent, METER_STREAM_KEY } from '@metamodels/schema'
import { ensureGroup, processOnce } from '../src/worker.js'

async function freshDb() {
  const db = drizzle(new PGlite(), { schema })
  const here = dirname(fileURLToPath(import.meta.url))
  await migrate(db, { migrationsFolder: resolve(here, '../../../packages/schema/drizzle') })
  return db
}
async function scope(db: Awaited<ReturnType<typeof freshDb>>) {
  const [org] = await db.insert(schema.org).values({ name: 'o' }).returning()
  const [flock] = await db.insert(schema.flock).values({ orgId: org.id, breed: 'ollama', name: 'f', baseUrl: 'http://x' }).returning()
  const [pad] = await db.insert(schema.paddock).values({ orgId: org.id, flockId: flock.id, slug: 's', name: 'p' }).returning()
  const [key] = await db.insert(schema.apiKey).values({ orgId: org.id, name: 'k', prefix: 'mm_live_w', hash: 'h' }).returning()
  return { orgId: org.id, keyId: key.id, paddockId: pad.id }
}

describe('processOnce', () => {
  test('reads pending stream entries, upserts rollups, and returns the count', async () => {
    const redis = new RedisMock()
    const db = await freshDb(); const s = await scope(db)
    await ensureGroup(redis as any)
    const at = Date.UTC(2026, 6, 27, 14)
    const { data } = encodeMeterEvent({ ...s, breedId: 'ollama', dim: 'tokens_out', value: 8, at })
    await redis.xadd(METER_STREAM_KEY, '*', 'data', data)

    const n = await processOnce(redis as any, db, 'c1')
    expect(n).toBe(1)
    const rows = await db.select().from(schema.usageRollup)
    expect(rows[0]).toMatchObject({ period: '2026-07-27T14', dim: 'tokens_out', value: 8 })
  })

  test('returns 0 when there is nothing pending', async () => {
    const redis = new RedisMock()
    const db = await freshDb(); await scope(db)
    await ensureGroup(redis as any)
    expect(await processOnce(redis as any, db, 'c1')).toBe(0)
  })

  test('acked entries are not reprocessed on the next pass (no double count)', async () => {
    const redis = new RedisMock()
    const db = await freshDb(); const s = await scope(db)
    await ensureGroup(redis as any)
    const at = Date.UTC(2026, 6, 27, 14)
    const { data } = encodeMeterEvent({ ...s, breedId: 'ollama', dim: 'jobs', value: 1, at })
    await redis.xadd(METER_STREAM_KEY, '*', 'data', data)
    await processOnce(redis as any, db, 'c1')
    await processOnce(redis as any, db, 'c1') // second pass: nothing new
    const rows = await db.select().from(schema.usageRollup)
    expect(rows).toHaveLength(1)
    expect(rows[0].value).toBe(1)
  })
})
```

> **ioredis-mock consumer-group risk:** if this version of `ioredis-mock` cannot emulate `XGROUP CREATE` / `XREADGROUP` / `XACK` faithfully, wrap this `describe` in `describe.skipIf(!process.env.REDIS_TEST_URL)` and construct `new Redis(process.env.REDIS_TEST_URL!)` instead of `RedisMock` (flush the stream key at test start). The aggregation correctness is already fully covered by Task 4's pglite tests; this test only proves the read→apply→ack wiring. Do NOT leave a red test — either it passes on the mock or it is `skipIf`-gated with the real-Redis path.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run apps/worker/test/worker.test.ts`
Expected: FAIL — `../src/worker.js` not found.

- [ ] **Step 3: Implement the consumer helpers** — `apps/worker/src/consumer.ts`:

```ts
import type { Redis } from 'ioredis'
import { decodeMeterEvent, METER_GROUP, METER_STREAM_KEY } from '@metamodels/schema'
import type { RollupEvent } from './aggregator.js'

/** Create the consumer group (idempotent). `MKSTREAM` creates the stream if absent. */
export async function ensureGroup(redis: Redis): Promise<void> {
  try {
    await redis.xgroup('CREATE', METER_STREAM_KEY, METER_GROUP, '$', 'MKSTREAM')
  } catch (e) {
    if (!String((e as Error).message).includes('BUSYGROUP')) throw e
  }
}

/** Read up to `count` new entries for this consumer. Returns decoded events + their stream ids. */
export async function readBatch(
  redis: Redis,
  consumer: string,
  count: number,
  blockMs: number,
): Promise<{ ids: string[]; events: RollupEvent[] }> {
  const res = (await redis.xreadgroup(
    'GROUP', METER_GROUP, consumer,
    'COUNT', String(count),
    'BLOCK', String(blockMs),
    'STREAMS', METER_STREAM_KEY, '>',
  )) as [string, [string, string[]][]][] | null

  const ids: string[] = []
  const events: RollupEvent[] = []
  if (!res) return { ids, events }
  for (const [, entries] of res) {
    for (const [id, fields] of entries) {
      ids.push(id)
      const e = decodeMeterEvent(fields)
      events.push({ orgId: e.orgId, keyId: e.keyId, paddockId: e.paddockId, dim: e.dim as RollupEvent['dim'], value: e.value, at: e.at })
    }
  }
  return { ids, events }
}

/** Acknowledge processed entries so they are not redelivered. */
export async function ackBatch(redis: Redis, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await redis.xack(METER_STREAM_KEY, METER_GROUP, ...ids)
}
```

`apps/worker/src/worker.ts`:

```ts
import type { Redis } from 'ioredis'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { applyEvents } from './aggregator.js'
import { ackBatch, ensureGroup, readBatch } from './consumer.js'

export { ensureGroup }

type Db = PgDatabase<any, any, any>

/**
 * One consume→aggregate→ack cycle. Returns the number of events processed.
 * Order matters for at-least-once delivery: the DB upsert commits BEFORE the
 * XACK, so a crash between them redelivers the batch (re-summing it). Exactly-once
 * dedup is deferred (see Plan 4 carry-forward) — acceptable because a crash mid-batch
 * is rare and only over-counts, never under-counts.
 */
export async function processOnce(redis: Redis, db: Db, consumer: string): Promise<number> {
  const { ids, events } = await readBatch(redis, consumer, 100, 1000)
  if (events.length === 0) return 0
  await applyEvents(db, events)
  await ackBatch(redis, ids)
  return events.length
}
```

`apps/worker/src/index.ts`:

```ts
import Redis from 'ioredis'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from '@metamodels/schema'
import { ensureGroup, processOnce } from './worker.js'

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  const redisUrl = process.env.REDIS_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  if (!redisUrl) throw new Error('REDIS_URL is required')

  const db = drizzle(postgres(databaseUrl), { schema })
  const redis = new Redis(redisUrl)
  const consumer = process.env.WORKER_NAME ?? `worker-${process.pid}`

  await ensureGroup(redis)
  // eslint-disable-next-line no-console
  console.log(`metamodels worker "${consumer}" consuming ${'metamodels:meters'}`)

  // Continuous loop: readBatch BLOCKs up to 1s when idle, so this is not a busy-spin.
  for (;;) {
    try {
      await processOnce(redis, db, consumer)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('worker cycle failed; retrying', err)
    }
  }
}

// Only run when executed directly, not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith('index.ts')) {
  void main()
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run apps/worker/test/worker.test.ts`
Expected: PASS (or the `skipIf` fallback engages per the risk note; in that case set `REDIS_TEST_URL` is unset → suite is skipped, still green).

- [ ] **Step 5: Typecheck + full suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/worker/src/consumer.ts apps/worker/src/worker.ts apps/worker/src/index.ts apps/worker/test/worker.test.ts
git commit -m "feat(worker): stream consumer loop (read→upsert→ack) + entrypoint"
```

---

### Task 7: `RedisRateLimiter` — atomic Lua sliding-window

**Files:**
- Create: `apps/data-plane/src/ratelimit/redis-rate-limiter.ts`
- Test: `apps/data-plane/test/redis-rate-limiter.test.ts`

**Interfaces:**
- Consumes: `RateLimit` from `../config/types.js`; `RateLimiter`, `RateLimitResult` from `./rate-limiter.js`.
- Produces: `class RedisRateLimiter implements RateLimiter` (constructor `(redis, { now? })`).

- [ ] **Step 1: Write the failing test** — `apps/data-plane/test/redis-rate-limiter.test.ts` (mirrors the InMemory limiter's behavior contract):

```ts
import { describe, expect, test } from 'vitest'
import RedisMock from 'ioredis-mock'
import { RedisRateLimiter } from '../src/ratelimit/redis-rate-limiter.js'

describe('RedisRateLimiter', () => {
  test('allows up to max within the window, then blocks', async () => {
    let t = 1_000_000
    const rl = new RedisRateLimiter(new RedisMock() as any, { now: () => t })
    const limit = { windowSec: 60, max: 2 }
    expect((await rl.check('k', limit)).allowed).toBe(true)
    expect((await rl.check('k', limit)).allowed).toBe(true)
    const blocked = await rl.check('k', limit)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSec).toBeGreaterThan(0)
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(60)
  })

  test('separate buckets are independent', async () => {
    let t = 0
    const rl = new RedisRateLimiter(new RedisMock() as any, { now: () => t })
    const limit = { windowSec: 60, max: 1 }
    expect((await rl.check('a', limit)).allowed).toBe(true)
    expect((await rl.check('b', limit)).allowed).toBe(true)
    expect((await rl.check('a', limit)).allowed).toBe(false)
  })

  test('the window slides: old hits expire', async () => {
    let t = 0
    const rl = new RedisRateLimiter(new RedisMock() as any, { now: () => t })
    const limit = { windowSec: 10, max: 1 }
    expect((await rl.check('k', limit)).allowed).toBe(true)
    t = 11_000
    expect((await rl.check('k', limit)).allowed).toBe(true)
  })
})
```

> **ioredis-mock EVAL risk:** if this `ioredis-mock` build cannot run the Lua below (ZSET commands inside EVAL), gate this `describe` with `describe.skipIf(!process.env.REDIS_TEST_URL)` and use a real Redis, exactly as in Task 6's note. Do not leave it red. The `InMemoryRateLimiter` remains the reference implementation whose semantics these tests encode.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run apps/data-plane/test/redis-rate-limiter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `apps/data-plane/src/ratelimit/redis-rate-limiter.ts`:

```ts
import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'
import type { RateLimit } from '../config/types.js'
import type { RateLimiter, RateLimitResult } from './rate-limiter.js'

// Atomic sliding-window-log over a ZSET (scores = timestamps ms). One round trip,
// one EVAL, so the trim→count→decide→add is indivisible across instances.
// KEYS[1]=bucket  ARGV: 1=now 2=windowMs 3=max 4=unique member id
// returns { allowed(1|0), retryAfterSec }
const SCRIPT = `
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - windowMs)
local count = redis.call('ZCARD', KEYS[1])
if count < max then
  redis.call('ZADD', KEYS[1], now, ARGV[4])
  redis.call('PEXPIRE', KEYS[1], windowMs)
  return {1, 0}
end
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
local retryMs = windowMs
if oldest[2] then retryMs = (tonumber(oldest[2]) + windowMs) - now end
local retrySec = math.ceil(retryMs / 1000)
if retrySec < 1 then retrySec = 1 end
return {0, retrySec}
`

export class RedisRateLimiter implements RateLimiter {
  private readonly now: () => number

  constructor(
    private readonly redis: Redis,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? (() => Date.now())
  }

  async check(bucketKey: string, limit: RateLimit): Promise<RateLimitResult> {
    const now = this.now()
    const res = (await this.redis.eval(
      SCRIPT,
      1,
      `rl:${bucketKey}`,
      String(now),
      String(limit.windowSec * 1000),
      String(limit.max),
      randomUUID(),
    )) as [number, number]
    return { allowed: res[0] === 1, retryAfterSec: res[1] }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run apps/data-plane/test/redis-rate-limiter.test.ts`
Expected: PASS (or `skipIf` fallback per the risk note).

- [ ] **Step 5: Commit**

```bash
git add apps/data-plane/src/ratelimit/redis-rate-limiter.ts apps/data-plane/test/redis-rate-limiter.test.ts
git commit -m "feat(data-plane): RedisRateLimiter atomic Lua sliding-window"
```

---

### Task 8: Quota caps — schema, `UsageReader`, and the request-path gate

**Files:**
- Create: `apps/data-plane/src/config/quota.ts`, `apps/data-plane/src/meter/usage-reader.ts`
- Modify: `apps/data-plane/src/app.ts` (add `usageReader` dep + gate)
- Test: `apps/data-plane/test/quota.integration.test.ts`

**Interfaces:**
- Consumes: `METER_DIMS`, `usageRollup`, `periodPrefix`, `QuotaWindow` from `@metamodels/schema`; `AppDeps` in `app.ts`; the existing app integration harness (fake Ollama + `makeDb`/`seedFixture`).
- Produces: `quotaRuleSchema`, `quotaSchema`, `QuotaRule` (`{ dim: MeterDim; max: number; period: QuotaWindow }`); `interface UsageReader { periodUsage(keyId, paddockId, dim, win, atMs): Promise<number> }`; `class DrizzleUsageReader`.

- [ ] **Step 1: Write the quota schema + reader test** — `apps/data-plane/test/quota.integration.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { createApp } from '../src/app.js'
import { buildRegistry } from '../src/breeds.js'
import { DrizzleConfigStore } from '../src/config/config-store.js'
import { InMemoryRateLimiter } from '../src/ratelimit/rate-limiter.js'
import { InMemoryMeterSink } from '../src/meter/meter-sink.js'
import { InMemoryJobStore } from '../src/jobs/job-store.js'
import { DrizzleUsageReader } from '../src/meter/usage-reader.js'
import { makeDb, seedFixture } from './helpers/seed.js'
import { makeFakeOllama } from './helpers/fake-ollama.js'
import * as schema from '@metamodels/schema'
import { periodBucket } from '@metamodels/schema'

async function appWithQuota(quota: unknown) {
  const db = await makeDb()
  const fx = await seedFixture(db)
  // attach a quota to the seeded fence
  await db.update(schema.fence).set({ quota }).where(eq(schema.fence.paddockId, fx.paddockId))
  const { app, drainMeters } = createApp({
    configStore: new DrizzleConfigStore(db),
    rateLimiter: new InMemoryRateLimiter(),
    meterSink: new InMemoryMeterSink(),
    registry: buildRegistry(),
    jobStore: new InMemoryJobStore(),
    usageReader: new DrizzleUsageReader(db),
    fetchImpl: makeFakeOllama(), // fake upstream so an allowed request can succeed
  })
  return { app, drainMeters, db, fx }
}
// NOTE: import { eq } from 'drizzle-orm' at top of file.

describe('quota enforcement', () => {
  test('a request at/over the period cap is rejected 429 quota exceeded', async () => {
    const { app, db, fx } = await appWithQuota([{ dim: 'tokens_out', max: 10, period: 'hour' }])
    // pre-seed usage at the cap for the current hour
    await db.insert(schema.usageRollup).values({
      orgId: fx.orgId, keyId: fx.keyId, paddockId: fx.paddockId,
      period: periodBucket(Date.now()), dim: 'tokens_out', value: 10,
    })
    const res = await app.request(`/p/${fx.slug}/api/chat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fx.keyPlaintext}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'llama3.2:1b', messages: [] }),
    })
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ error: 'quota exceeded', dim: 'tokens_out' })
  })

  test('a request under the cap passes the quota gate', async () => {
    const { app, fx } = await appWithQuota([{ dim: 'tokens_out', max: 1000, period: 'hour' }])
    const res = await app.request(`/p/${fx.slug}/api/chat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fx.keyPlaintext}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'llama3.2:1b', messages: [] }),
    })
    expect(res.status).toBe(200)
  })

  test('no quota on the fence → gate is skipped', async () => {
    const { app, fx } = await appWithQuota(null)
    const res = await app.request(`/p/${fx.slug}/api/chat`, {
      method: 'POST',
      headers: { authorization: `Bearer ${fx.keyPlaintext}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'llama3.2:1b', messages: [] }),
    })
    expect(res.status).toBe(200)
  })
})
```

> Confirm the fake-Ollama helper's exported name and the allowed route/model by reading `apps/data-plane/test/helpers/fake-ollama.ts` and an existing `app.integration.test.ts` case; mirror their exact request shape (path, model id, headers). Adjust `makeFakeOllama`/route above to match what already exists rather than inventing a new helper.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run apps/data-plane/test/quota.integration.test.ts`
Expected: FAIL — `../src/meter/usage-reader.js` / `usageReader` dep not found.

- [ ] **Step 3: Implement the quota schema** — `apps/data-plane/src/config/quota.ts`:

```ts
import { z } from 'zod'
import { METER_DIMS } from '@metamodels/schema'

export const quotaRuleSchema = z.object({
  dim: z.enum(METER_DIMS),
  max: z.number().int().nonnegative(),
  period: z.enum(['hour', 'day', 'month']),
})

/** A fence's `quota` column: a list of hard caps, each on one dimension per period. */
export const quotaSchema = z.array(quotaRuleSchema)

export type QuotaRule = z.infer<typeof quotaRuleSchema>
```

- [ ] **Step 4: Implement the reader** — `apps/data-plane/src/meter/usage-reader.ts`:

```ts
import { and, eq, like, sql } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { periodPrefix, usageRollup, type QuotaWindow } from '@metamodels/schema'

export interface UsageReader {
  /** Sum of a dimension's rollup value for the (key,paddock) over the quota window containing `atMs`. */
  periodUsage(keyId: string, paddockId: string, dim: string, win: QuotaWindow, atMs: number): Promise<number>
}

type Db = PgDatabase<any, any, any>

export class DrizzleUsageReader implements UsageReader {
  constructor(private readonly db: Db) {}

  async periodUsage(keyId: string, paddockId: string, dim: string, win: QuotaWindow, atMs: number): Promise<number> {
    const prefix = periodPrefix(win, atMs)
    const rows = await this.db
      .select({ total: sql<number>`coalesce(sum(${usageRollup.value}), 0)` })
      .from(usageRollup)
      .where(
        and(
          eq(usageRollup.keyId, keyId),
          eq(usageRollup.paddockId, paddockId),
          eq(usageRollup.dim, dim),
          like(usageRollup.period, `${prefix}%`),
        ),
      )
    return Number(rows[0]?.total ?? 0)
  }
}
```

- [ ] **Step 5: Wire the gate into `app.ts`** — three edits:

(a) Add imports near the other config imports:

```ts
import { quotaSchema } from './config/quota.js'
import type { UsageReader } from './meter/usage-reader.js'
```

(b) Add the optional dep to `AppDeps`:

```ts
export interface AppDeps {
  configStore: ConfigStore
  rateLimiter: RateLimiter
  meterSink: MeterSink
  registry: BreedRegistry
  jobStore: JobStore
  usageReader?: UsageReader
  fetchImpl?: FetchImpl
  defaultRateLimit?: RateLimit
}
```

(c) In the `app.all('/p/:slug/*', …)` handler, insert the quota gate **immediately after the rate-limit block** (after the `if (!rl.allowed) { … }` and before `// 4. Parse body`):

```ts
    // 3b. Quota caps (hard). Read the current period's rollup total per rule and
    //     reject at/over the cap. Enforced against already-aggregated usage, so a
    //     single in-flight request may cross the cap before it is counted
    //     (bounded by worker lag) — acceptable for v1; see Plan 4 carry-forward.
    if (deps.usageReader && paddock.fence.quota != null) {
      const parsed = quotaSchema.safeParse(paddock.fence.quota)
      if (parsed.success) {
        const now = Date.now()
        for (const rule of parsed.data) {
          const used = await deps.usageReader.periodUsage(resolvedKey.keyId, paddock.paddockId, rule.dim, rule.period, now)
          if (used >= rule.max) {
            return c.json({ error: 'quota exceeded', dim: rule.dim }, 429)
          }
        }
      }
    }
```

- [ ] **Step 6: Run to verify it passes**

Run: `pnpm vitest run apps/data-plane/test/quota.integration.test.ts`
Expected: PASS.

- [ ] **Step 7: Full suite (existing app tests must be untouched — they pass no `usageReader`, so the gate is skipped)**

Run: `pnpm typecheck && pnpm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/data-plane/src/config/quota.ts apps/data-plane/src/meter/usage-reader.ts apps/data-plane/src/app.ts apps/data-plane/test/quota.integration.test.ts
git commit -m "feat(data-plane): hard quota caps read from usage rollups"
```

---

### Task 9: Wire `server.ts` (env-driven Redis/Postgres) + health/readiness routes

**Files:**
- Modify: `apps/data-plane/src/server.ts`, `apps/data-plane/src/app.ts` (add `/healthz` + optional `readiness` dep)
- Test: `apps/data-plane/test/server-config.test.ts` (add), `apps/data-plane/test/healthz.test.ts` (create)

**Interfaces:**
- Consumes: `PostgresJobStore` (T3), `RedisMeterSink` (T5), `RedisRateLimiter` (T7), `DrizzleUsageReader` (T8).
- Produces: `ServerConfig` gains `redisUrl?: string`; `AppDeps` gains `readiness?: () => Promise<boolean>`; `/healthz` (liveness) + `/readyz` (readiness) routes.

- [ ] **Step 1: Write the failing tests.**

Add to `apps/data-plane/test/server-config.test.ts`:

```ts
test('reads REDIS_URL when present', () => {
  const cfg = loadServerConfig({ DATABASE_URL: 'postgres://x/y', REDIS_URL: 'redis://localhost:6379' })
  expect(cfg.redisUrl).toBe('redis://localhost:6379')
})

test('redisUrl is undefined when REDIS_URL is absent (in-memory dev mode)', () => {
  expect(loadServerConfig({ DATABASE_URL: 'postgres://x/y' }).redisUrl).toBeUndefined()
})
```

Create `apps/data-plane/test/healthz.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { createApp } from '../src/app.js'
import { buildRegistry } from '../src/breeds.js'
import { InMemoryRateLimiter } from '../src/ratelimit/rate-limiter.js'
import { InMemoryMeterSink } from '../src/meter/meter-sink.js'
import { InMemoryJobStore } from '../src/jobs/job-store.js'
import type { ConfigStore } from '../src/config/config-store.js'

const stubConfig: ConfigStore = {
  resolveKeyByHash: async () => null,
  getPaddockBySlug: async () => null,
}

function make(readiness?: () => Promise<boolean>) {
  return createApp({
    configStore: stubConfig,
    rateLimiter: new InMemoryRateLimiter(),
    meterSink: new InMemoryMeterSink(),
    registry: buildRegistry(),
    jobStore: new InMemoryJobStore(),
    readiness,
  }).app
}

describe('health routes', () => {
  test('GET /healthz is always 200 (liveness)', async () => {
    const res = await make().request('/healthz')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  test('GET /readyz is 200 when the readiness probe resolves true', async () => {
    const res = await make(async () => true).request('/readyz')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ready: true })
  })

  test('GET /readyz is 503 when the readiness probe resolves false or throws', async () => {
    expect((await make(async () => false).request('/readyz')).status).toBe(503)
    expect((await make(async () => { throw new Error('down') }).request('/readyz')).status).toBe(503)
  })

  test('GET /readyz is 200 with no probe configured (nothing to check)', async () => {
    expect((await make().request('/readyz')).status).toBe(200)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run apps/data-plane/test/server-config.test.ts apps/data-plane/test/healthz.test.ts`
Expected: FAIL — `redisUrl` undefined-vs-missing / `/healthz` route 404 / `readiness` dep unknown.

- [ ] **Step 3: Add the health routes to `app.ts`.**

Extend `AppDeps` with the optional probe (add beside `usageReader`):

```ts
  readiness?: () => Promise<boolean>
```

Register the two routes **at the very start of `createApp`, right after `const app = new Hono()`** (before the `/p/:slug/*` catch-all so they are matched first):

```ts
  // Liveness: the process is up and serving. Cheap, dependency-free.
  app.get('/healthz', (c) => c.json({ status: 'ok' }))

  // Readiness: dependencies (DB, Redis) are reachable. 503 until they are.
  app.get('/readyz', async (c) => {
    if (!deps.readiness) return c.json({ ready: true })
    try {
      return (await deps.readiness()) ? c.json({ ready: true }) : c.json({ ready: false }, 503)
    } catch {
      return c.json({ ready: false }, 503)
    }
  })
```

- [ ] **Step 4: Rewire `server.ts`** — replace the file body with:

```ts
import { serve } from '@hono/node-server'
import { drizzle } from 'drizzle-orm/postgres-js'
import { sql } from 'drizzle-orm'
import postgres from 'postgres'
import Redis from 'ioredis'
import * as schema from '@metamodels/schema'
import { createApp } from './app.js'
import { buildRegistry } from './breeds.js'
import { DrizzleConfigStore } from './config/config-store.js'
import { InMemoryRateLimiter, type RateLimiter } from './ratelimit/rate-limiter.js'
import { RedisRateLimiter } from './ratelimit/redis-rate-limiter.js'
import { InMemoryMeterSink, type MeterSink } from './meter/meter-sink.js'
import { RedisMeterSink } from './meter/redis-meter-sink.js'
import { DrizzleUsageReader } from './meter/usage-reader.js'
import { PostgresJobStore } from './jobs/postgres-job-store.js'

export interface ServerConfig {
  databaseUrl: string
  redisUrl?: string
  port: number
}

export function loadServerConfig(env: Record<string, string | undefined>): ServerConfig {
  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  const port = env.PORT ? Number(env.PORT) : 8787
  if (Number.isNaN(port)) throw new Error('PORT must be a number')
  return { databaseUrl, redisUrl: env.REDIS_URL, port }
}

export function startServer(cfg: ServerConfig): void {
  const client = postgres(cfg.databaseUrl)
  const db = drizzle(client, { schema })

  // Redis-backed infra in production (durable + cross-instance atomic); an
  // in-memory fallback keeps single-process dev runnable without Redis. The
  // job store and usage reader are always Postgres-backed (durable).
  let rateLimiter: RateLimiter
  let meterSink: MeterSink
  let redis: Redis | undefined
  if (cfg.redisUrl) {
    redis = new Redis(cfg.redisUrl)
    rateLimiter = new RedisRateLimiter(redis)
    meterSink = new RedisMeterSink(redis)
  } else {
    rateLimiter = new InMemoryRateLimiter()
    meterSink = new InMemoryMeterSink()
  }

  const { app } = createApp({
    configStore: new DrizzleConfigStore(db),
    rateLimiter,
    meterSink,
    registry: buildRegistry(),
    jobStore: new PostgresJobStore(db),
    usageReader: new DrizzleUsageReader(db),
    readiness: async () => {
      await db.execute(sql`select 1`)
      if (redis) await redis.ping()
      return true
    },
  })

  serve({ fetch: app.fetch, port: cfg.port })
  // eslint-disable-next-line no-console
  console.log(`metamodels data-plane listening on :${cfg.port}${cfg.redisUrl ? ' (redis)' : ' (in-memory)'}`)
}

// Only run when executed directly, not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  startServer(loadServerConfig(process.env))
}
```

Add `ioredis@5.4.2` to `apps/data-plane/package.json` dependencies (it now imports `ioredis`):

```json
    "ioredis": "5.4.2",
```

Then `pnpm install`.

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm vitest run apps/data-plane/test/server-config.test.ts apps/data-plane/test/healthz.test.ts`
Expected: PASS.

- [ ] **Step 6: Full typecheck + suite**

Run: `pnpm typecheck && pnpm test`
Expected: PASS (all prior tests + the new Plan 4 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/data-plane/src/server.ts apps/data-plane/src/app.ts apps/data-plane/package.json apps/data-plane/test/server-config.test.ts apps/data-plane/test/healthz.test.ts pnpm-lock.yaml
git commit -m "feat(data-plane): env-driven Redis/Postgres wiring + health/readiness routes"
```

---

## Self-review (run before requesting whole-branch review)

1. **Spec/roadmap coverage** — map each Milestone-4 requirement to a task:
   - Redis-stream consumer → `usage_rollup` in Postgres → **T1 (unique index), T4 (aggregator), T5 (producer/codec), T6 (consumer loop)**.
   - Composite UNIQUE + additive upsert (Plan 1 carry-forward) → **T1 + T4**.
   - `JobStore.markMetered` atomic CAS across instances (Plan 3 carry-forward) → **T3**.
   - Redis rate limiter at the `server.ts` seam (Plan 2 carry-forward) → **T7 + T9**.
   - Hard quota-cap enforcement → **T8**.
   - Health probes → **T9**.
   - Infra swap behind existing interfaces, in-memory doubles retained for tests → **T9 wiring; every backend implements the frozen interface**.
2. **Placeholder scan** — every code step contains real code; every run step names an exact command + expected result. No TBDs.
3. **Type consistency** — `RollupEvent`, `MeterStreamEvent`, `QuotaRule`, `UsageReader`, `PostgresJobStore`, `RedisMeterSink`, `RedisRateLimiter`, `processOnce`, `applyEvents`, `periodBucket/periodPrefix` are each defined once and referenced by the exact same name/signature downstream. `JobStore`/`MeterSink`/`RateLimiter` interfaces are consumed verbatim from their existing definitions.

---

## Plan 4 carry-forward (record deferred items here after the whole-branch review)

Seed the "Carry-forward from Plan 4" section of the roadmap doc with any of these that survive review, plus whatever the review surfaces:

- **Exactly-once metering:** the worker is at-least-once (DB commit before XACK). A crash between commit and ack re-sums a batch. Add per-message dedup (track processed stream ids, or a processed-offset table) if double-counting under crash is unacceptable — **Plan 6** (needs the real-Redis integration harness to test).
- **Quota burst window:** caps are enforced against aggregated rollups, which lag the stream by worker latency; a burst can cross the cap before it is counted, and an in-flight request that will push usage over is still allowed (pre-request check). For a truly synchronous hard cap, maintain a Redis counter incremented on emit. Revisit if a hard ceiling (not a soft cap) is required.
- **ConfigStore caching:** deliberately **not** added in Plan 4 — a cache without invalidation serves stale config after an operator edit. Add a `CachingConfigStore` in **Plan 5** alongside the Redis pub/sub invalidation the control plane will publish on config writes (per the Plan 2 carry-forward). Document the pairing.
- **Real-Redis integration tests:** any Task 6/7 test gated behind `REDIS_TEST_URL` (ioredis-mock fidelity fallback) must be run against a real Redis in **Plan 6**'s docker-compose integration suite.
- **Stream trimming / retention:** `MAXLEN ~ 100_000` is a coarse cap. If meter throughput is high, size retention against worker throughput or move to time-based `MINID` trimming.
- **Pending-entries recovery:** `processOnce` only reads new (`>`) entries; entries delivered to a consumer that then crashed sit in the PEL forever. Add an `XAUTOCLAIM` reclaim pass for stuck pending entries — **Plan 6**.
- **Worker health/liveness:** the worker has no health endpoint or metrics; add a liveness signal (heartbeat key / HTTP probe) for docker-compose healthchecks in **Plan 6**.
