# MetaModels v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. **Execution config (per operator): use the `opus` model for BOTH the implementer (code) subagent AND the reviewer subagent.** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-hosted, local-first proxy that puts auth, API keys, rate limiting, per-provider constraints, and usage metering in front of local Ollama and ComfyUI servers, on a shared connector SDK.

**Architecture:** Control-plane / data-plane split, TypeScript end-to-end in a pnpm monorepo. A Hono data plane sits in the public hot path (auth → rate-limit → fence guard → streaming proxy → meter emit); a Next.js control plane manages config; a worker aggregates metering. Postgres (Drizzle) is the source of truth; Redis is the hot-path cache/counter/stream layer. Connectors ("Breeds") are shared TS modules imported by both planes.

**Tech Stack:** TypeScript · pnpm workspaces · Hono (Node 22) · Next.js 15 + shadcn/ui + Tailwind · Postgres 16 + Drizzle ORM · Redis 7 · Zod · Auth.js (NextAuth v5) · Vitest · Docker Compose. Tests use `@electric-sql/pglite` (in-memory Postgres) and fake HTTP upstreams so the suite runs without Docker.

## Global Constraints

_Every task's requirements implicitly include this section._

- **License:** AGPL-3.0. Add SPDX header `// SPDX-License-Identifier: AGPL-3.0-only` is NOT required per-file, but the repo `LICENSE` must be AGPL-3.0.
- **Git identity:** `Carmelo Santana <me@carmelosantana.com>`; branch `main`.
- **Language:** TypeScript everywhere; Node 22 runtime; ES modules (`"type": "module"`).
- **Package manager:** pnpm workspaces only. No npm/yarn lockfiles.
- **API key format:** `mm_live_` prefix; stored **hashed** (SHA-256 hex), never plaintext. Prefix (`mm_live_` + 4 chars) shown in UI.
- **Ollama MUTATE class is hard-denied and not exposable in v1:** `/api/pull`, `/api/push`, `/api/create`, `/api/copy`, `/api/delete`, `/api/blobs`.
- **ComfyUI:** raw node-graph submission is structurally impossible through a Paddock; `/view` and `/history` are never exposed directly.
- **Tenancy:** single-operator, but `org_id` FK on every entity (org-ready).
- **Hot path never touches Postgres per-request** — only Redis.
- **TDD:** every behavior gets a failing test first. **Frequent commits** (one per task minimum). DRY, YAGNI.
- **Herding names** (Breed / Flock / Paddock / Fence / Key) are placeholders pending designer sign-off; use them in code for now.

---

## Milestone Roadmap (plan set)

Each milestone is its own plan that produces working, tested software. **Plan 1 is fully expanded below.** Plans 2–6 are scoped here and expanded to bite-sized task-by-task detail just-in-time before each is executed (via a fresh `writing-plans` pass), so each expansion is informed by the prior milestone's reality.

| # | Milestone | Deliverable (working + tested) | Key packages/apps |
|---|---|---|---|
| **1** | **Foundation & Connector SDK** | Typed monorepo: schema package (Drizzle tables + migrations + key helpers, pglite-tested) and connector SDK (Breed contract + registry, tested with an echo breed). | `packages/schema`, `packages/connectors` |
| **2** | **Ollama breed + minimal data plane** | `curl` a Paddock → fenced, rate-limited, metered Ollama chat/generate/embed against a fake Ollama; MUTATE denied; token metering from final NDJSON line. | `apps/data-plane`, `packages/connectors/ollama` |
| **3** | **ComfyUI breed** | `POST {template_id, params}` → server-reconstructed graph submitted; image-upload param; scoped `result/{jobId}`; `/ws` job/gpu_ms/images metering. Wraps latex.pics `v0.3.2` + `v0.3.2-img` fixtures. | `packages/connectors/comfyui`, data-plane |
| **4** | **Worker & rollups** | Redis-stream consumer → `UsageRollup` in Postgres; health probes; hard quota-cap enforcement. Usage is queryable. | `apps/worker` |
| **5** | **Control plane** | Next.js + shadcn admin: operator login; CRUD for Flock / Paddock / Fence / WorkflowTemplate / ApiKey; plain usage view; audit log. Config edits invalidate data-plane cache via Redis pub/sub. | `apps/control-plane` |
| **6** | **Packaging & integration** | `docker compose up` runs all 5 services; multi-stage images; env config; README + setup docs; end-to-end integration test across the whole stack. | repo root, `docker/`, `docs/` |

**Acceptance for v1 (end of Plan 6):** an operator can, from the UI, connect a Flock to a local Ollama and a local ComfyUI, publish a small-models-only Ollama Paddock and a template-based ComfyUI Paddock (wrapping `v0.3.2`), mint a key, and a consumer can call both with rate-limiting, constraint enforcement, and accurate metered usage visible in the UI — all via `docker compose up`.

---

# PLAN 1 — Foundation & Connector SDK

**Milestone goal:** a typed, tested foundation. No HTTP surface yet — this milestone delivers the schema package (database tables, migrations, key helpers) and the connector SDK (the Breed contract + registry) with full test coverage, so Plans 2+ build on stable interfaces.

## File structure (Plan 1)

```
package.json                      # root: workspaces, scripts, devDeps (pnpm, vitest, typescript, tsx)
pnpm-workspace.yaml
tsconfig.base.json                # shared compiler options
vitest.config.ts                  # root vitest config (workspace-wide)
LICENSE                           # AGPL-3.0 text
packages/
  schema/
    package.json
    tsconfig.json
    drizzle.config.ts
    src/
      index.ts                    # re-exports
      enums.ts                    # BreedId, RouteClass, MeterDim, statuses
      schema.ts                   # Drizzle pgTable definitions (all entities)
      types.ts                    # inferred row types (InferSelect/InferInsert)
      keys.ts                     # generateApiKey(), hashApiKey()
    test/
      keys.test.ts                # pure unit tests
      schema.test.ts              # pglite integration: migrate + FK enforcement
    drizzle/                      # generated migrations (drizzle-kit)
  connectors/
    package.json
    tsconfig.json
    src/
      index.ts                    # re-exports
      breed.ts                    # Breed<C> interface + supporting types + defineBreed()
      registry.ts                 # BreedRegistry
      testing/echo-breed.ts       # sample breed used only in tests
    test/
      registry.test.ts
      contract.test.ts            # exercises the Breed contract via echo breed
```

---

### Task 1: Monorepo scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `LICENSE`
- Create: `packages/schema/package.json`, `packages/schema/tsconfig.json`
- Test: `packages/schema/test/sanity.test.ts` (temporary sanity check, deleted in Task 2)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a working pnpm workspace where `pnpm test` runs Vitest across packages. Node 22, ESM.

- [ ] **Step 1: Write the failing test**

`packages/schema/test/sanity.test.ts`:
```ts
import { expect, test } from 'vitest'

test('workspace runs vitest', () => {
  expect(1 + 1).toBe(2)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test` (from repo root)
Expected: FAIL — no `package.json` / vitest not installed (command errors).

- [ ] **Step 3: Create scaffold files**

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
  - "apps/*"
```

`package.json` (root):
```json
{
  "name": "metamodels",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -b --pretty"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "tsx": "^4.19.0"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "declaration": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "verbatimModuleSyntax": true,
    "types": ["node"]
  }
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.ts'],
    environment: 'node',
  },
})
```

`packages/schema/package.json`:
```json
{
  "name": "@metamodels/schema",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" }
}
```

`packages/schema/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

`LICENSE`: the full AGPL-3.0 text (fetch from https://www.gnu.org/licenses/agpl-3.0.txt).

- [ ] **Step 4: Install and run the test**

Run: `pnpm install && pnpm test`
Expected: PASS — 1 test passes (`sanity.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: scaffold pnpm monorepo with vitest + AGPL license"
```

---

### Task 2: API key helpers (`@metamodels/schema`)

**Files:**
- Create: `packages/schema/src/keys.ts`, `packages/schema/src/index.ts`
- Delete: `packages/schema/test/sanity.test.ts`
- Test: `packages/schema/test/keys.test.ts`

**Interfaces:**
- Consumes: Node `node:crypto`.
- Produces:
  - `interface GeneratedKey { plaintext: string; prefix: string; hash: string }`
  - `generateApiKey(): GeneratedKey` — plaintext starts `mm_live_`; `prefix` is first 12 chars; `hash` is 64-char SHA-256 hex of plaintext.
  - `hashApiKey(plaintext: string): string` — 64-char SHA-256 hex.

- [ ] **Step 1: Write the failing test**

`packages/schema/test/keys.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import { generateApiKey, hashApiKey } from '../src/keys.js'

describe('api keys', () => {
  test('generates mm_live_ prefixed plaintext', () => {
    const k = generateApiKey()
    expect(k.plaintext.startsWith('mm_live_')).toBe(true)
    expect(k.plaintext.length).toBeGreaterThan(20)
  })

  test('prefix is first 12 chars of plaintext', () => {
    const k = generateApiKey()
    expect(k.prefix).toBe(k.plaintext.slice(0, 12))
    expect(k.prefix.startsWith('mm_live_')).toBe(true)
  })

  test('hash is 64-char hex and matches hashApiKey', () => {
    const k = generateApiKey()
    expect(k.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hashApiKey(k.plaintext)).toBe(k.hash)
  })

  test('two generated keys differ', () => {
    expect(generateApiKey().plaintext).not.toBe(generateApiKey().plaintext)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test keys`
Expected: FAIL — cannot resolve `../src/keys.js`.

- [ ] **Step 3: Write minimal implementation**

`packages/schema/src/keys.ts`:
```ts
import { createHash, randomBytes } from 'node:crypto'

export interface GeneratedKey {
  plaintext: string
  prefix: string
  hash: string
}

export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex')
}

export function generateApiKey(): GeneratedKey {
  const raw = randomBytes(24).toString('base64url')
  const plaintext = `mm_live_${raw}`
  const prefix = plaintext.slice(0, 12)
  return { plaintext, prefix, hash: hashApiKey(plaintext) }
}
```

`packages/schema/src/index.ts`:
```ts
export * from './keys.js'
```

- [ ] **Step 4: Run test to verify it passes; remove sanity test**

Run: `rm packages/schema/test/sanity.test.ts && pnpm test`
Expected: PASS — 4 key tests pass, sanity test gone.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(schema): api key generation + SHA-256 hashing helpers"
```

---

### Task 3: Database schema + migrations (`@metamodels/schema`)

**Files:**
- Create: `packages/schema/src/enums.ts`, `packages/schema/src/schema.ts`, `packages/schema/src/types.ts`, `packages/schema/drizzle.config.ts`
- Modify: `packages/schema/src/index.ts`, `packages/schema/package.json` (add deps + scripts)
- Test: `packages/schema/test/schema.test.ts`

**Interfaces:**
- Consumes: `drizzle-orm/pg-core`, `@electric-sql/pglite`, `drizzle-orm/pglite`.
- Produces (exported table objects, all with `orgId` FK where noted):
  - `org`, `user`, `flock`, `paddock`, `fence`, `workflowTemplate`, `apiKey`, `keyPaddock`, `usageRollup`, `auditLog`
  - Inferred types in `types.ts`: e.g. `type Flock = typeof flock.$inferSelect`, `type NewFlock = typeof flock.$inferInsert`, and the same pattern for each table.
  - Enums in `enums.ts`: `BREED_IDS = ['ollama','comfyui'] as const`; `ROUTE_CLASSES = ['read','infer','mutate'] as const`; `METER_DIMS = ['tokens_in','tokens_out','jobs','gpu_ms','images'] as const`; `PADDOCK_STATUS = ['active','disabled'] as const`; `KEY_STATUS = ['active','revoked'] as const`.

- [ ] **Step 1: Add dependencies**

Run:
```bash
pnpm --filter @metamodels/schema add drizzle-orm
pnpm --filter @metamodels/schema add -D drizzle-kit @electric-sql/pglite
```
Add to `packages/schema/package.json` scripts:
```json
"scripts": {
  "db:generate": "drizzle-kit generate",
  "db:migrate": "drizzle-kit migrate"
}
```

- [ ] **Step 2: Write the failing test**

`packages/schema/test/schema.test.ts`:
```ts
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, test } from 'vitest'
import { apiKey, fence, flock, org, paddock } from '../src/schema.js'

let db: ReturnType<typeof drizzle>

beforeAll(async () => {
  const client = new PGlite()
  db = drizzle(client, { schema: { org, flock, paddock, fence, apiKey } })
  // Push schema directly for the test DB (no migration files needed here).
  const { pushSchema } = await import('./helpers/push.js')
  await pushSchema(client)
})

describe('schema', () => {
  test('org → flock → paddock → fence chain inserts and reads back', async () => {
    const [o] = await db.insert(org).values({ name: 'default' }).returning()
    const [f] = await db.insert(flock).values({
      orgId: o.id, breed: 'ollama', name: 'local-ollama',
      baseUrl: 'http://localhost:11434',
    }).returning()
    const [p] = await db.insert(paddock).values({
      orgId: o.id, flockId: f.id, slug: 'small-models', name: 'Small models',
    }).returning()
    const [fc] = await db.insert(fence).values({
      orgId: o.id, paddockId: p.id, constraintJson: { allowedRoutes: ['chat'] },
      rateLimit: { windowSec: 60, max: 30 }, quota: null,
    }).returning()

    expect(f.breed).toBe('ollama')
    expect(p.slug).toBe('small-models')
    expect((fc.constraintJson as { allowedRoutes: string[] }).allowedRoutes).toContain('chat')

    const found = await db.select().from(paddock).where(eq(paddock.slug, 'small-models'))
    expect(found).toHaveLength(1)
  })

  test('apiKey stores hash not plaintext', async () => {
    const [o] = await db.insert(org).values({ name: 'k' }).returning()
    const [k] = await db.insert(apiKey).values({
      orgId: o.id, name: 'test', prefix: 'mm_live_abcd',
      hash: 'a'.repeat(64), status: 'active',
    }).returning()
    expect(k.hash).toHaveLength(64)
    expect((k as Record<string, unknown>).plaintext).toBeUndefined()
  })
})
```

Also create the test helper `packages/schema/test/helpers/push.ts` that creates tables from the Drizzle schema using raw SQL derived from the schema (simplest reliable approach for pglite):
```ts
import type { PGlite } from '@electric-sql/pglite'

// Minimal DDL mirroring src/schema.ts, used only for in-memory tests.
export async function pushSchema(client: PGlite): Promise<void> {
  await client.exec(`
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    CREATE TABLE org (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE flock (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
      breed text NOT NULL,
      name text NOT NULL,
      base_url text NOT NULL,
      upstream_auth text,
      tls_trust boolean NOT NULL DEFAULT false,
      health_ok boolean,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE paddock (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
      flock_id uuid NOT NULL REFERENCES flock(id) ON DELETE CASCADE,
      slug text NOT NULL UNIQUE,
      name text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE fence (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
      paddock_id uuid NOT NULL REFERENCES paddock(id) ON DELETE CASCADE,
      constraint_json jsonb NOT NULL,
      rate_limit jsonb,
      quota jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE api_key (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id uuid NOT NULL REFERENCES org(id) ON DELETE CASCADE,
      name text NOT NULL,
      prefix text NOT NULL,
      hash text NOT NULL UNIQUE,
      status text NOT NULL DEFAULT 'active',
      expires_at timestamptz,
      overrides jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `)
}
```
_(Note for implementer: `gen_random_uuid()` is built into pglite/pgcrypto; the `uuid-ossp` line is a harmless safety net. Keep this DDL in sync with `src/schema.ts` — Task 3 Step 5 verifies parity by generating real migrations.)_

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test schema`
Expected: FAIL — cannot resolve `../src/schema.js`.

- [ ] **Step 4: Write the Drizzle schema**

`packages/schema/src/enums.ts`:
```ts
export const BREED_IDS = ['ollama', 'comfyui'] as const
export const ROUTE_CLASSES = ['read', 'infer', 'mutate'] as const
export const METER_DIMS = ['tokens_in', 'tokens_out', 'jobs', 'gpu_ms', 'images'] as const
export const PADDOCK_STATUS = ['active', 'disabled'] as const
export const KEY_STATUS = ['active', 'revoked'] as const

export type BreedId = (typeof BREED_IDS)[number]
export type RouteClass = (typeof ROUTE_CLASSES)[number]
export type MeterDim = (typeof METER_DIMS)[number]
```

`packages/schema/src/schema.ts`:
```ts
import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

const id = () => uuid('id').primaryKey().defaultRandom()
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

export const org = pgTable('org', {
  id: id(),
  name: text('name').notNull(),
  createdAt: createdAt(),
})

export const user = pgTable('user', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('admin'),
  createdAt: createdAt(),
})

export const flock = pgTable('flock', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  breed: text('breed').notNull(),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  upstreamAuth: text('upstream_auth'),
  tlsTrust: boolean('tls_trust').notNull().default(false),
  healthOk: boolean('health_ok'),
  createdAt: createdAt(),
})

export const paddock = pgTable('paddock', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  flockId: uuid('flock_id').notNull().references(() => flock.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  status: text('status').notNull().default('active'),
  createdAt: createdAt(),
})

export const fence = pgTable('fence', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  paddockId: uuid('paddock_id').notNull().references(() => paddock.id, { onDelete: 'cascade' }),
  constraintJson: jsonb('constraint_json').notNull(),
  rateLimit: jsonb('rate_limit'),
  quota: jsonb('quota'),
  createdAt: createdAt(),
})

export const workflowTemplate = pgTable('workflow_template', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  flockId: uuid('flock_id').notNull().references(() => flock.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  graphJson: jsonb('graph_json').notNull(),
  paramSchema: jsonb('param_schema').notNull(),
  cost: integer('cost').notNull().default(1),
  createdAt: createdAt(),
})

export const apiKey = pgTable('api_key', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  prefix: text('prefix').notNull(),
  hash: text('hash').notNull().unique(),
  status: text('status').notNull().default('active'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  overrides: jsonb('overrides'),
  createdAt: createdAt(),
})

export const keyPaddock = pgTable('key_paddock', {
  id: id(),
  keyId: uuid('key_id').notNull().references(() => apiKey.id, { onDelete: 'cascade' }),
  paddockId: uuid('paddock_id').notNull().references(() => paddock.id, { onDelete: 'cascade' }),
})

export const usageRollup = pgTable('usage_rollup', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  keyId: uuid('key_id').notNull().references(() => apiKey.id, { onDelete: 'cascade' }),
  paddockId: uuid('paddock_id').notNull().references(() => paddock.id, { onDelete: 'cascade' }),
  period: text('period').notNull(), // e.g. '2026-07-25T14' (hour bucket)
  dim: text('dim').notNull(),
  value: integer('value').notNull().default(0),
})

export const auditLog = pgTable('audit_log', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  target: text('target').notNull(),
  detail: jsonb('detail'),
  createdAt: createdAt(),
})
```

`packages/schema/src/types.ts`:
```ts
import type {
  apiKey, auditLog, fence, flock, keyPaddock, org, paddock, user,
  usageRollup, workflowTemplate,
} from './schema.js'

export type Org = typeof org.$inferSelect
export type NewOrg = typeof org.$inferInsert
export type User = typeof user.$inferSelect
export type NewUser = typeof user.$inferInsert
export type Flock = typeof flock.$inferSelect
export type NewFlock = typeof flock.$inferInsert
export type Paddock = typeof paddock.$inferSelect
export type NewPaddock = typeof paddock.$inferInsert
export type Fence = typeof fence.$inferSelect
export type NewFence = typeof fence.$inferInsert
export type WorkflowTemplate = typeof workflowTemplate.$inferSelect
export type NewWorkflowTemplate = typeof workflowTemplate.$inferInsert
export type ApiKey = typeof apiKey.$inferSelect
export type NewApiKey = typeof apiKey.$inferInsert
export type KeyPaddock = typeof keyPaddock.$inferSelect
export type UsageRollup = typeof usageRollup.$inferSelect
export type AuditLog = typeof auditLog.$inferSelect
```

`packages/schema/drizzle.config.ts`:
```ts
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/metamodels' },
})
```

Update `packages/schema/src/index.ts`:
```ts
export * from './keys.js'
export * from './enums.js'
export * from './schema.js'
export * from './types.js'
```

- [ ] **Step 5: Run tests + generate real migrations**

Run: `pnpm test schema`
Expected: PASS — both schema tests pass against pglite.

Run: `pnpm --filter @metamodels/schema db:generate`
Expected: a migration SQL file appears under `packages/schema/drizzle/`. Open it and confirm every table in `schema.ts` is present (parity check with the test DDL).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(schema): drizzle tables, inferred types, enums, migrations"
```

---

### Task 4: Breed contract + registry (`@metamodels/connectors`)

**Files:**
- Create: `packages/connectors/package.json`, `packages/connectors/tsconfig.json`
- Create: `packages/connectors/src/breed.ts`, `packages/connectors/src/registry.ts`, `packages/connectors/src/index.ts`
- Create: `packages/connectors/src/testing/echo-breed.ts`
- Test: `packages/connectors/test/registry.test.ts`, `packages/connectors/test/contract.test.ts`

**Interfaces:**
- Consumes: `zod` (peer of both planes), `@metamodels/schema` enums (`MeterDim`, `RouteClass`).
- Produces (the contract every breed and both planes import):
  - Types: `RouteSpec`, `RequestCtx`, `RewrittenRequest`, `GuardResult`, `MeterEvent`, `HealthStatus`, `UpstreamResult`, `FlockRef`.
  - `interface Breed<C>` with: `id`, `displayName`, `routes: RouteSpec[]`, `constraintSchema: ZodTypeAny`, `health(flock)`, `guard(ctx, fence): GuardResult | Promise<GuardResult>`, `meter(ctx, upstream): MeterEvent[]`, `billingDimensions: MeterDim[]`, optional `toMcp?(fence)`.
  - `defineBreed<C>(breed: Breed<C>): Breed<C>` (identity helper).
  - `class BreedRegistry` with `register(breed)`, `get(id): Breed`, `has(id): boolean`, `ids(): string[]`; `register` throws on duplicate id, `get` throws on unknown id.

- [ ] **Step 1: Create package + add deps**

`packages/connectors/package.json`:
```json
{
  "name": "@metamodels/connectors",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@metamodels/schema": "workspace:*",
    "zod": "^3.23.0"
  }
}
```

`packages/connectors/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing tests**

`packages/connectors/src/testing/echo-breed.ts`:
```ts
import { z } from 'zod'
import { defineBreed } from '../breed.js'

// A trivial breed used only by tests to exercise the contract.
export const echoConstraint = z.object({ allow: z.boolean().default(true) })
export type EchoConstraint = z.infer<typeof echoConstraint>

export const echoBreed = defineBreed<EchoConstraint>({
  id: 'echo',
  displayName: 'Echo (test)',
  routes: [{ method: 'POST', path: '/echo', class: 'infer', exposeByDefault: true }],
  constraintSchema: echoConstraint,
  async health() { return { ok: true } },
  guard(ctx, fence) {
    if (!fence.allow) return { ok: false, status: 403, reason: 'not allowed' }
    return { ok: true, request: { method: ctx.method, path: ctx.path, headers: ctx.headers, body: ctx.body } }
  },
  meter(_ctx, upstream) {
    const tokens = (upstream.body as { tokens?: number }).tokens ?? 0
    return [{ dim: 'tokens_out', value: tokens, at: 0 }]
  },
  billingDimensions: ['tokens_out'],
})
```

`packages/connectors/test/registry.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import { BreedRegistry } from '../src/registry.js'
import { echoBreed } from '../src/testing/echo-breed.js'

describe('BreedRegistry', () => {
  test('registers and gets a breed', () => {
    const r = new BreedRegistry()
    r.register(echoBreed)
    expect(r.has('echo')).toBe(true)
    expect(r.get('echo').displayName).toBe('Echo (test)')
    expect(r.ids()).toEqual(['echo'])
  })

  test('throws on duplicate registration', () => {
    const r = new BreedRegistry()
    r.register(echoBreed)
    expect(() => r.register(echoBreed)).toThrow(/already registered/)
  })

  test('throws on unknown breed', () => {
    const r = new BreedRegistry()
    expect(() => r.get('nope')).toThrow(/Unknown breed/)
  })
})
```

`packages/connectors/test/contract.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import type { RequestCtx, UpstreamResult } from '../src/breed.js'
import { echoBreed } from '../src/testing/echo-breed.js'

const ctx: RequestCtx = {
  method: 'POST', path: '/echo', headers: {}, body: { hi: 1 }, paddockSlug: 'p',
}

describe('Breed contract via echo', () => {
  test('guard allows when fence.allow is true', () => {
    const r = echoBreed.guard(ctx, { allow: true })
    expect(r).toEqual({ ok: true, request: { method: 'POST', path: '/echo', headers: {}, body: { hi: 1 } } })
  })

  test('guard denies when fence.allow is false', () => {
    const r = echoBreed.guard(ctx, { allow: false })
    expect(r).toEqual({ ok: false, status: 403, reason: 'not allowed' })
  })

  test('meter extracts tokens from upstream body', () => {
    const up: UpstreamResult = { status: 200, headers: {}, body: { tokens: 7 } }
    expect(echoBreed.meter(ctx, up)).toEqual([{ dim: 'tokens_out', value: 7, at: 0 }])
  })

  test('constraintSchema validates', () => {
    expect(echoBreed.constraintSchema.parse({})).toEqual({ allow: true })
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test connectors`
Expected: FAIL — cannot resolve `../src/breed.js` / `../src/registry.js`.

- [ ] **Step 4: Write the contract + registry**

`packages/connectors/src/breed.ts`:
```ts
import type { ZodTypeAny } from 'zod'
import type { MeterDim, RouteClass } from '@metamodels/schema'

export interface RouteSpec {
  method: string
  path: string
  class: RouteClass
  exposeByDefault: boolean
}

export interface RequestCtx {
  method: string
  path: string
  headers: Record<string, string>
  body: unknown
  paddockSlug: string
}

export interface RewrittenRequest {
  method: string
  path: string
  headers: Record<string, string>
  body: unknown
}

export type GuardResult =
  | { ok: true; request: RewrittenRequest }
  | { ok: false; status: 401 | 403 | 422; reason: string }

export interface MeterEvent {
  dim: MeterDim
  value: number
  at: number
}

export interface HealthStatus {
  ok: boolean
  detail?: string
}

export interface UpstreamResult {
  status: number
  headers: Record<string, string>
  body: unknown
  finalFrame?: unknown
}

export interface FlockRef {
  baseUrl: string
  upstreamAuth?: string | null
  tlsTrust?: boolean
}

export interface Breed<C = unknown> {
  id: string
  displayName: string
  routes: RouteSpec[]
  constraintSchema: ZodTypeAny
  health(flock: FlockRef): Promise<HealthStatus>
  guard(ctx: RequestCtx, fence: C): GuardResult | Promise<GuardResult>
  meter(ctx: RequestCtx, upstream: UpstreamResult): MeterEvent[]
  billingDimensions: MeterDim[]
  toMcp?(fence: C): unknown[]
}

export function defineBreed<C>(breed: Breed<C>): Breed<C> {
  return breed
}
```

`packages/connectors/src/registry.ts`:
```ts
import type { Breed } from './breed.js'

export class BreedRegistry {
  private readonly breeds = new Map<string, Breed<unknown>>()

  register(breed: Breed<unknown>): void {
    if (this.breeds.has(breed.id)) {
      throw new Error(`Breed already registered: ${breed.id}`)
    }
    this.breeds.set(breed.id, breed)
  }

  get(id: string): Breed<unknown> {
    const breed = this.breeds.get(id)
    if (!breed) throw new Error(`Unknown breed: ${id}`)
    return breed
  }

  has(id: string): boolean {
    return this.breeds.has(id)
  }

  ids(): string[] {
    return [...this.breeds.keys()]
  }
}
```

`packages/connectors/src/index.ts`:
```ts
export * from './breed.js'
export * from './registry.js'
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test connectors`
Expected: PASS — all registry + contract tests pass.

Run: `pnpm typecheck`
Expected: PASS — no type errors across the workspace.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(connectors): Breed contract, registry, and test echo breed"
```

---

## Plan 1 Self-Review

- **Spec coverage (Plan 1 scope):** monorepo ✓ (Task 1), schema tables + org-ready FKs ✓ (Task 3), hashed key helpers `mm_live_` ✓ (Task 2), Breed SDK contract with `guard`/`meter`/`constraintSchema`/`billingDimensions`/`toMcp?` ✓ (Task 4), `UsageRollup` keyed by key×paddock×dim×period ✓ (Task 3). Breeds themselves, data plane, worker, control plane, docker are Plans 2–6 by design.
- **Placeholder scan:** no TBD/TODO; every code step has complete code; the pglite test DDL is fully written and its parity with `schema.ts` is verified by generating real migrations in Task 3 Step 5.
- **Type consistency:** `MeterDim`/`RouteClass` are defined once in `@metamodels/schema/enums.ts` and imported by `breed.ts`; `GuardResult`, `MeterEvent`, `UpstreamResult`, `RequestCtx` names match between `breed.ts`, `echo-breed.ts`, and both test files; `BreedRegistry` method names (`register`/`get`/`has`/`ids`) match across `registry.ts` and `registry.test.ts`.

---

## Next steps after Plan 1

Once Plan 1 is green and committed, run a fresh `writing-plans` pass to expand **Plan 2 (Ollama breed + minimal data plane)** to bite-sized detail — it will define: the Hono app skeleton, the `POST /p/:slug/*` ingress, the Redis key-cache + sliding-window limiter, the `guard → proxy → meter` middleware chain, a fake-Ollama test upstream, and the Ollama breed's route classification, model allowlist enforcement, `stream_options.include_usage` injection, and final-NDJSON-line token metering.
