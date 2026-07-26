# MetaModels Plan 2 — Ollama Breed + Minimal Data Plane

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. **Execution config: use the `opus` (4.8) model for BOTH the implementer (code) subagents AND the reviewer subagents.** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Hono data plane so a consumer can `curl` a Paddock and get a fenced, rate-limited, metered Ollama response — with dangerous model-management endpoints denied and token usage extracted from the final NDJSON line.

**Architecture:** A Hono app exposes `ALL /p/:slug/*`. Each request runs a fixed chain: authenticate the `mm_live_` key → resolve the Paddock/Fence/Flock → rate-limit → `breed.guard()` enforcement → stream-proxy to the upstream (teeing the body so the final NDJSON frame is captured) → `breed.meter()` → emit to a `MeterSink`. Infrastructure (`ConfigStore`, `RateLimiter`, `MeterSink`) is behind interfaces with in-memory / pglite implementations here; Plan 4 swaps in Redis-backed versions.

**Tech Stack:** TypeScript · Hono · `@metamodels/connectors` (Breed SDK from Plan 1) · `@metamodels/schema` (Drizzle tables from Plan 1) · Drizzle ORM · Zod · Vitest · `@electric-sql/pglite` (test DB) · `@hono/node-server` + `postgres` (runtime bootstrap only).

## Global Constraints

_Every task's requirements implicitly include this section._

- **License:** AGPL-3.0. **Git identity:** `Carmelo Santana <me@carmelosantana.com>`. **Branch:** work on `feat/metamodels-plan-2` (created by the controller); never commit to `main`.
- **Language:** TypeScript, Node 22+, ES modules (`"type": "module"`), `.js` import extensions, `verbatimModuleSyntax` (type-only imports where only types are used).
- **Package manager:** pnpm workspaces only.
- **API keys:** `mm_live_` prefix; compared by **SHA-256 hash** via `hashApiKey` from `@metamodels/schema` — the data plane never sees or stores plaintext beyond the inbound header.
- **Ollama MUTATE class is hard-denied and NOT configurable to expose:** `/api/pull`, `/api/push`, `/api/create`, `/api/copy`, `/api/delete`, `/api/blobs`. Denial happens in `guard`, before any upstream call.
- **Hot path never touches Postgres per-request in production.** In this milestone the `ConfigStore` reads the DB directly; a Redis cache layer is added in Plan 5 (config) / Plan 4 (counters). Design `ConfigStore` as an interface so that swap is non-breaking.
- **`org_id` scoping:** every meter record and config lookup carries `orgId`.
- **v2 scope decision (documented):** the Ollama Fence supports an **explicit `allowedModels` string list** (or `null` = all models allowed). The size-bound variant (`maxParamB`/`maxSizeBytes`) needs a cached `/api/tags` map and is deferred to a later milestone — do NOT build it here (YAGNI).
- **Carry-forward #4 resolution:** keep `Breed.constraintSchema: ZodTypeAny` in the interface; each breed exports a locally-typed schema (`z.ZodType<C>`) so `guard(ctx, fence: C)` stays type-checked at the breed. Do not change the `Breed` interface.
- **Testing:** TDD; tests run with pglite + an injected `fetchImpl` (no real ports, no Docker). Frequent commits. DRY, YAGNI.

---

## File Structure

```
packages/connectors/src/
  ollama/
    constraint.ts     # ollamaConstraint zod schema + OllamaConstraint type + route-group map
    breed.ts          # ollamaBreed: defineBreed({... guard, meter, health ...})
    index.ts          # re-export ollamaBreed, ollamaConstraint
  index.ts            # (modify) also export ./ollama
packages/connectors/test/
  ollama-guard.test.ts
  ollama-meter.test.ts

apps/data-plane/
  package.json
  tsconfig.json
  src/
    config/
      types.ts        # ResolvedKey, ResolvedPaddock, RateLimit, KeyOverrides
      config-store.ts # ConfigStore interface + DrizzleConfigStore
    ratelimit/
      rate-limiter.ts # RateLimiter interface + InMemoryRateLimiter
    meter/
      meter-sink.ts   # MeterSink interface + MeterEventRecord + InMemoryMeterSink
    proxy/
      proxy.ts        # proxyToUpstream (tee + final-frame capture)
    app.ts            # createApp(deps) -> { app, drainMeters }
    breeds.ts         # buildRegistry() -> BreedRegistry with ollamaBreed
    server.ts         # runtime bootstrap (env, drizzle(postgres), @hono/node-server)
  test/
    helpers/
      fake-ollama.ts  # Hono app simulating Ollama; injected via fetchImpl
      seed.ts         # seed a pglite DB with org/flock/paddock/fence/key fixtures
    config-store.test.ts
    rate-limiter.test.ts
    meter-sink.test.ts
    proxy.test.ts
    app.integration.test.ts
```

---

### Task 1: Ollama breed — constraints, routing, and guard

**Files:**
- Create: `packages/connectors/src/ollama/constraint.ts`, `packages/connectors/src/ollama/breed.ts`, `packages/connectors/src/ollama/index.ts`
- Modify: `packages/connectors/src/index.ts` (add `export * from './ollama/index.js'`)
- Test: `packages/connectors/test/ollama-guard.test.ts`

**Interfaces:**
- Consumes: `defineBreed`, `Breed`, `RequestCtx`, `GuardResult` from `../breed.js`; `zod`.
- Produces:
  - `ollamaConstraint: z.ZodType<OllamaConstraint>` where `OllamaConstraint = { allowedRoutes: ('chat'|'generate'|'embed'|'read')[]; allowedModels: string[] | null }`.
  - `routeGroup(path: string): 'chat'|'generate'|'embed'|'read'|'mutate'|'unknown'`.
  - `ollamaBreed: Breed<OllamaConstraint>` — this task implements `id`, `displayName`, `routes`, `constraintSchema`, `guard`, `billingDimensions`. (`meter` and `health` are added in Task 2 as a minimal stub now, filled in Task 2.)

- [ ] **Step 1: Write the failing test**

`packages/connectors/test/ollama-guard.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import { ollamaBreed, ollamaConstraint, routeGroup } from '../src/ollama/index.js'
import type { RequestCtx } from '../src/breed.js'

function ctx(path: string, body: unknown = {}, method = 'POST'): RequestCtx {
  return { method, path, headers: {}, body, paddockSlug: 'p' }
}
const fence = (over = {}) => ollamaConstraint.parse({ allowedRoutes: ['chat', 'generate', 'embed', 'read'], allowedModels: null, ...over })

describe('routeGroup', () => {
  test.each([
    ['/api/chat', 'chat'], ['/v1/chat/completions', 'chat'],
    ['/api/generate', 'generate'], ['/v1/completions', 'generate'],
    ['/api/embed', 'embed'], ['/api/embeddings', 'embed'], ['/v1/embeddings', 'embed'],
    ['/api/tags', 'read'], ['/api/version', 'read'], ['/v1/models', 'read'],
    ['/api/pull', 'mutate'], ['/api/delete', 'mutate'], ['/api/blobs/sha256:abc', 'mutate'],
    ['/api/nonsense', 'unknown'],
  ])('%s -> %s', (path, group) => {
    expect(routeGroup(path)).toBe(group)
  })
})

describe('ollamaBreed.guard', () => {
  test('denies MUTATE routes with 403 before any upstream call', () => {
    const r = ollamaBreed.guard(ctx('/api/pull', { name: 'llama3' }), fence())
    expect(r).toMatchObject({ ok: false, status: 403 })
  })

  test('denies a route group not in allowedRoutes', () => {
    const r = ollamaBreed.guard(ctx('/api/chat', { model: 'x' }), fence({ allowedRoutes: ['read'] }))
    expect(r).toMatchObject({ ok: false, status: 403 })
  })

  test('denies a model not on the allowlist', () => {
    const r = ollamaBreed.guard(ctx('/api/chat', { model: 'llama3:70b' }), fence({ allowedModels: ['llama3.2:1b'] }))
    expect(r).toMatchObject({ ok: false, status: 403 })
  })

  test('allows an allowlisted model and passes the body through', () => {
    const r = ollamaBreed.guard(ctx('/api/chat', { model: 'llama3.2:1b', messages: [] }), fence({ allowedModels: ['llama3.2:1b'] }))
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.request.body as { model: string }).model).toBe('llama3.2:1b')
  })

  test('allows all models when allowedModels is null', () => {
    const r = ollamaBreed.guard(ctx('/api/chat', { model: 'anything' }), fence())
    expect(r.ok).toBe(true)
  })

  test('injects stream_options.include_usage on /v1 streaming requests', () => {
    const r = ollamaBreed.guard(ctx('/v1/chat/completions', { model: 'm', stream: true }), fence())
    expect(r.ok).toBe(true)
    if (r.ok) expect((r.request.body as { stream_options: { include_usage: boolean } }).stream_options.include_usage).toBe(true)
  })

  test('read routes need no model and are allowed when "read" is permitted', () => {
    const r = ollamaBreed.guard(ctx('/api/tags', undefined, 'GET'), fence())
    expect(r.ok).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test ollama-guard`
Expected: FAIL — cannot resolve `../src/ollama/index.js`.

- [ ] **Step 3: Write the constraint + route map**

`packages/connectors/src/ollama/constraint.ts`:
```ts
import { z } from 'zod'

export const ollamaConstraint = z.object({
  allowedRoutes: z.array(z.enum(['chat', 'generate', 'embed', 'read'])).min(1).default(['chat']),
  allowedModels: z.array(z.string()).nullable().default(null),
})

export type OllamaConstraint = z.infer<typeof ollamaConstraint>

export type OllamaRouteGroup = 'chat' | 'generate' | 'embed' | 'read' | 'mutate' | 'unknown'

export function routeGroup(path: string): OllamaRouteGroup {
  const p = path.split('?')[0]
  if (p === '/api/chat' || p === '/v1/chat/completions') return 'chat'
  if (p === '/api/generate' || p === '/v1/completions') return 'generate'
  if (p === '/api/embed' || p === '/api/embeddings' || p === '/v1/embeddings') return 'embed'
  if (
    p === '/api/tags' || p === '/api/show' || p === '/api/ps' || p === '/api/version' ||
    p === '/v1/models' || p.startsWith('/v1/models/')
  ) return 'read'
  if (
    p === '/api/pull' || p === '/api/push' || p === '/api/create' ||
    p === '/api/copy' || p === '/api/delete' || p.startsWith('/api/blobs')
  ) return 'mutate'
  return 'unknown'
}
```

- [ ] **Step 4: Write the breed with guard (meter/health minimal for now)**

`packages/connectors/src/ollama/breed.ts`:
```ts
import { defineBreed } from '../breed.js'
import type { Breed, GuardResult, RequestCtx, UpstreamResult, MeterEvent } from '../breed.js'
import { ollamaConstraint, routeGroup } from './constraint.js'
import type { OllamaConstraint } from './constraint.js'

export const ollamaBreed: Breed<OllamaConstraint> = defineBreed<OllamaConstraint>({
  id: 'ollama',
  displayName: 'Ollama',
  routes: [
    { method: 'POST', path: '/api/chat', class: 'infer', exposeByDefault: true },
    { method: 'POST', path: '/api/generate', class: 'infer', exposeByDefault: true },
    { method: 'POST', path: '/api/embed', class: 'infer', exposeByDefault: true },
    { method: 'GET', path: '/api/tags', class: 'read', exposeByDefault: true },
    { method: 'POST', path: '/api/pull', class: 'mutate', exposeByDefault: false },
    { method: 'DELETE', path: '/api/delete', class: 'mutate', exposeByDefault: false },
  ],
  constraintSchema: ollamaConstraint,
  billingDimensions: ['tokens_in', 'tokens_out'],

  guard(ctx: RequestCtx, fence: OllamaConstraint): GuardResult {
    const group = routeGroup(ctx.path)
    if (group === 'mutate') {
      return { ok: false, status: 403, reason: 'model-management endpoints are not permitted' }
    }
    if (group === 'unknown') {
      return { ok: false, status: 403, reason: `route not permitted: ${ctx.path}` }
    }
    if (!fence.allowedRoutes.includes(group)) {
      return { ok: false, status: 403, reason: `route group '${group}' is not allowed by this paddock` }
    }

    let body = ctx.body
    if (group !== 'read') {
      const model = (body as { model?: unknown } | null)?.model
      if (fence.allowedModels !== null) {
        if (typeof model !== 'string' || !fence.allowedModels.includes(model)) {
          return { ok: false, status: 403, reason: `model not allowed: ${typeof model === 'string' ? model : '(none)'}` }
        }
      }
      if (ctx.path.startsWith('/v1/') && (body as { stream?: unknown } | null)?.stream === true) {
        const b = body as Record<string, unknown>
        body = { ...b, stream_options: { ...(b.stream_options as object ?? {}), include_usage: true } }
      }
    }
    return { ok: true, request: { method: ctx.method, path: ctx.path, headers: ctx.headers, body } }
  },

  // Filled in Task 2.
  meter(_ctx: RequestCtx, _upstream: UpstreamResult): MeterEvent[] {
    return []
  },
  async health() {
    return { ok: true }
  },
})
```

`packages/connectors/src/ollama/index.ts`:
```ts
export { ollamaBreed } from './breed.js'
export { ollamaConstraint, routeGroup } from './constraint.js'
export type { OllamaConstraint, OllamaRouteGroup } from './constraint.js'
```

Modify `packages/connectors/src/index.ts` — append:
```ts
export * from './ollama/index.js'
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test ollama-guard`
Expected: PASS — all routeGroup + guard tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/connectors/src/ollama packages/connectors/src/index.ts packages/connectors/test/ollama-guard.test.ts
git commit -m "feat(connectors): ollama breed constraints + guard (route/model fencing, mutate deny)"
```

---

### Task 2: Ollama breed — token metering + health

**Files:**
- Modify: `packages/connectors/src/ollama/breed.ts` (replace the `meter` and `health` stubs)
- Test: `packages/connectors/test/ollama-meter.test.ts`

**Interfaces:**
- Consumes: `UpstreamResult`, `MeterEvent` from `../breed.js`.
- Produces: `ollamaBreed.meter(ctx, upstream): MeterEvent[]` — reads `upstream.finalFrame ?? upstream.body`; emits `tokens_in` from `prompt_eval_count` (native) or `usage.prompt_tokens` (/v1), and `tokens_out` from `eval_count` or `usage.completion_tokens`; emits an event only when its value `> 0`. `ollamaBreed.health(flock)` GETs `${baseUrl}/api/version`.

- [ ] **Step 1: Write the failing test**

`packages/connectors/test/ollama-meter.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import { ollamaBreed } from '../src/ollama/index.js'
import type { RequestCtx, UpstreamResult } from '../src/breed.js'

const ctx: RequestCtx = { method: 'POST', path: '/api/chat', headers: {}, body: {}, paddockSlug: 'p' }
const up = (body: unknown, finalFrame?: unknown): UpstreamResult => ({ status: 200, headers: {}, body, finalFrame })

describe('ollamaBreed.meter', () => {
  test('extracts native counts from the final NDJSON frame', () => {
    const events = ollamaBreed.meter(ctx, up(undefined, { done: true, prompt_eval_count: 11, eval_count: 22 }))
    expect(events).toEqual([
      { dim: 'tokens_in', value: 11, at: expect.any(Number) },
      { dim: 'tokens_out', value: 22, at: expect.any(Number) },
    ])
  })

  test('extracts /v1 usage object counts', () => {
    const events = ollamaBreed.meter(ctx, up({ usage: { prompt_tokens: 7, completion_tokens: 0 } }))
    expect(events).toEqual([{ dim: 'tokens_in', value: 7, at: expect.any(Number) }])
  })

  test('emits nothing when counts are absent or zero (cache hit)', () => {
    expect(ollamaBreed.meter(ctx, up({ done: true }))).toEqual([])
    expect(ollamaBreed.meter(ctx, up(null, null))).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test ollama-meter`
Expected: FAIL — meter currently returns `[]` for the native-counts case.

- [ ] **Step 3: Replace the meter + health stubs**

In `packages/connectors/src/ollama/breed.ts`, replace the `meter(...)` and `health()` members with:
```ts
  meter(_ctx: RequestCtx, upstream: UpstreamResult): MeterEvent[] {
    const frame = (upstream.finalFrame ?? upstream.body) as Record<string, unknown> | null
    if (!frame || typeof frame !== 'object') return []

    let tokensIn = 0
    let tokensOut = 0
    if (typeof frame.prompt_eval_count === 'number') tokensIn = frame.prompt_eval_count
    if (typeof frame.eval_count === 'number') tokensOut = frame.eval_count

    const usage = frame.usage as Record<string, unknown> | undefined
    if (usage && typeof usage === 'object') {
      if (typeof usage.prompt_tokens === 'number') tokensIn = usage.prompt_tokens
      if (typeof usage.completion_tokens === 'number') tokensOut = usage.completion_tokens
    }

    const at = Date.now()
    const events: MeterEvent[] = []
    if (tokensIn > 0) events.push({ dim: 'tokens_in', value: tokensIn, at })
    if (tokensOut > 0) events.push({ dim: 'tokens_out', value: tokensOut, at })
    return events
  },

  async health(flock) {
    try {
      const res = await fetch(`${flock.baseUrl.replace(/\/$/, '')}/api/version`)
      return { ok: res.ok }
    } catch (err) {
      return { ok: false, detail: String(err) }
    }
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test ollama-meter`
Expected: PASS. Then `pnpm test connectors` — all connectors tests still green.

- [ ] **Step 5: Commit**

```bash
git add packages/connectors/src/ollama/breed.ts packages/connectors/test/ollama-meter.test.ts
git commit -m "feat(connectors): ollama token metering (native + /v1 usage) and health"
```

---

### Task 3: Data-plane package + ConfigStore

**Files:**
- Create: `apps/data-plane/package.json`, `apps/data-plane/tsconfig.json`
- Create: `apps/data-plane/src/config/types.ts`, `apps/data-plane/src/config/config-store.ts`
- Create: `apps/data-plane/test/helpers/seed.ts`
- Test: `apps/data-plane/test/config-store.test.ts`
- Modify: root `tsconfig.json` (add `{ "path": "apps/data-plane" }` reference)

**Interfaces:**
- Consumes: `@metamodels/schema` tables + `hashApiKey`; `drizzle-orm`.
- Produces:
  - Types (`config/types.ts`): `RateLimit = { windowSec: number; max: number }`; `KeyOverrides = { rateLimit?: RateLimit }`; `ResolvedKey = { keyId: string; orgId: string; status: string; expiresAt: Date | null; paddockSlugs: string[]; overrides: KeyOverrides | null }`; `ResolvedPaddock = { paddockId: string; orgId: string; slug: string; status: string; breedId: string; flock: { baseUrl: string; upstreamAuth: string | null; tlsTrust: boolean }; fence: { constraintJson: unknown; rateLimit: RateLimit | null; quota: unknown } }`.
  - `interface ConfigStore { resolveKeyByHash(hash: string): Promise<ResolvedKey | null>; getPaddockBySlug(slug: string): Promise<ResolvedPaddock | null> }`.
  - `class DrizzleConfigStore implements ConfigStore` (constructor takes a Drizzle `PgDatabase`).
  - Test helper `seedFixture(db)` in `test/helpers/seed.ts`: inserts one org, one ollama flock, one paddock (`slug: 'small'`, fence `allowedRoutes:['chat','generate','embed','read']`, `allowedModels:['llama3.2:1b']`, `rateLimit:{windowSec:60,max:5}`), and one api key (plaintext `mm_live_testkey`, stored hashed) linked to the paddock; returns `{ orgId, paddockId, keyId, keyPlaintext, keyHash, slug }`.

- [ ] **Step 1: Create the package + deps**

`apps/data-plane/package.json`:
```json
{
  "name": "@metamodels/data-plane",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/server.ts",
  "dependencies": {
    "@metamodels/connectors": "workspace:*",
    "@metamodels/schema": "workspace:*",
    "drizzle-orm": "^0.36.0",
    "hono": "^4.6.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@electric-sql/pglite": "^0.2.0"
  }
}
```
(Use the same `drizzle-orm` and `@electric-sql/pglite` versions already resolved in `packages/schema` — check its `package.json` and match, so the lockfile stays single-versioned.)

`apps/data-plane/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "composite": true },
  "references": [{ "path": "../../packages/schema" }, { "path": "../../packages/connectors" }],
  "include": ["src"]
}
```
Add to root `tsconfig.json` `references`: `{ "path": "apps/data-plane" }`. Run `pnpm install`.

- [ ] **Step 2: Write the failing test**

`apps/data-plane/test/helpers/seed.ts`:
```ts
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as schema from '@metamodels/schema'
import { hashApiKey } from '@metamodels/schema'

export type TestDb = ReturnType<typeof drizzle<typeof schema>>

export async function makeDb(): Promise<TestDb> {
  const client = new PGlite()
  const db = drizzle(client, { schema })
  // migrations live in the schema package's drizzle/ dir
  const here = dirname(fileURLToPath(import.meta.url))
  const migrationsFolder = resolve(here, '../../../../packages/schema/drizzle')
  await migrate(db, { migrationsFolder })
  return db
}

export interface Fixture {
  orgId: string; paddockId: string; keyId: string
  keyPlaintext: string; keyHash: string; slug: string
}

export async function seedFixture(db: TestDb): Promise<Fixture> {
  const [org] = await db.insert(schema.org).values({ name: 'default' }).returning()
  const [flock] = await db.insert(schema.flock).values({
    orgId: org.id, breed: 'ollama', name: 'local', baseUrl: 'http://fake.ollama',
  }).returning()
  const [paddock] = await db.insert(schema.paddock).values({
    orgId: org.id, flockId: flock.id, slug: 'small', name: 'Small models',
  }).returning()
  await db.insert(schema.fence).values({
    orgId: org.id, paddockId: paddock.id,
    constraintJson: { allowedRoutes: ['chat', 'generate', 'embed', 'read'], allowedModels: ['llama3.2:1b'] },
    rateLimit: { windowSec: 60, max: 5 }, quota: null,
  })
  const keyPlaintext = 'mm_live_testkey'
  const keyHash = hashApiKey(keyPlaintext)
  const [key] = await db.insert(schema.apiKey).values({
    orgId: org.id, name: 'test', prefix: keyPlaintext.slice(0, 12), hash: keyHash, status: 'active',
  }).returning()
  await db.insert(schema.keyPaddock).values({ keyId: key.id, paddockId: paddock.id })
  return { orgId: org.id, paddockId: paddock.id, keyId: key.id, keyPlaintext, keyHash, slug: 'small' }
}
```

`apps/data-plane/test/config-store.test.ts`:
```ts
import { beforeAll, describe, expect, test } from 'vitest'
import { DrizzleConfigStore } from '../src/config/config-store.js'
import { makeDb, seedFixture, type Fixture, type TestDb } from './helpers/seed.js'

let db: TestDb
let fx: Fixture
let store: DrizzleConfigStore

beforeAll(async () => {
  db = await makeDb()
  fx = await seedFixture(db)
  store = new DrizzleConfigStore(db)
})

describe('DrizzleConfigStore', () => {
  test('resolves a key by hash with its paddock slugs', async () => {
    const rk = await store.resolveKeyByHash(fx.keyHash)
    expect(rk).not.toBeNull()
    expect(rk!.keyId).toBe(fx.keyId)
    expect(rk!.orgId).toBe(fx.orgId)
    expect(rk!.paddockSlugs).toEqual(['small'])
  })

  test('returns null for an unknown hash', async () => {
    expect(await store.resolveKeyByHash('0'.repeat(64))).toBeNull()
  })

  test('loads a paddock with flock + fence', async () => {
    const p = await store.getPaddockBySlug('small')
    expect(p).not.toBeNull()
    expect(p!.breedId).toBe('ollama')
    expect(p!.flock.baseUrl).toBe('http://fake.ollama')
    expect((p!.fence.constraintJson as { allowedModels: string[] }).allowedModels).toEqual(['llama3.2:1b'])
    expect(p!.fence.rateLimit).toEqual({ windowSec: 60, max: 5 })
  })

  test('returns null for an unknown slug', async () => {
    expect(await store.getPaddockBySlug('nope')).toBeNull()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test config-store`
Expected: FAIL — cannot resolve `../src/config/config-store.js`.

- [ ] **Step 4: Write the types + store**

`apps/data-plane/src/config/types.ts`:
```ts
export interface RateLimit {
  windowSec: number
  max: number
}

export interface KeyOverrides {
  rateLimit?: RateLimit
}

export interface ResolvedKey {
  keyId: string
  orgId: string
  status: string
  expiresAt: Date | null
  paddockSlugs: string[]
  overrides: KeyOverrides | null
}

export interface ResolvedPaddock {
  paddockId: string
  orgId: string
  slug: string
  status: string
  breedId: string
  flock: { baseUrl: string; upstreamAuth: string | null; tlsTrust: boolean }
  fence: { constraintJson: unknown; rateLimit: RateLimit | null; quota: unknown }
}
```

`apps/data-plane/src/config/config-store.ts`:
```ts
import { and, eq } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { apiKey, fence, flock, keyPaddock, paddock } from '@metamodels/schema'
import type { KeyOverrides, RateLimit, ResolvedKey, ResolvedPaddock } from './types.js'

export interface ConfigStore {
  resolveKeyByHash(hash: string): Promise<ResolvedKey | null>
  getPaddockBySlug(slug: string): Promise<ResolvedPaddock | null>
}

// Accepts any Drizzle Postgres database (postgres-js in prod, pglite in tests).
type Db = PgDatabase<any, any, any>

export class DrizzleConfigStore implements ConfigStore {
  constructor(private readonly db: Db) {}

  async resolveKeyByHash(hash: string): Promise<ResolvedKey | null> {
    const rows = await this.db.select().from(apiKey).where(eq(apiKey.hash, hash)).limit(1)
    const key = rows[0]
    if (!key || key.status !== 'active') return null

    const links = await this.db
      .select({ slug: paddock.slug })
      .from(keyPaddock)
      .innerJoin(paddock, eq(keyPaddock.paddockId, paddock.id))
      .where(eq(keyPaddock.keyId, key.id))

    return {
      keyId: key.id,
      orgId: key.orgId,
      status: key.status,
      expiresAt: key.expiresAt ?? null,
      paddockSlugs: links.map((l) => l.slug),
      overrides: (key.overrides as KeyOverrides | null) ?? null,
    }
  }

  async getPaddockBySlug(slug: string): Promise<ResolvedPaddock | null> {
    const rows = await this.db
      .select({ paddock, flock, fence })
      .from(paddock)
      .innerJoin(flock, eq(paddock.flockId, flock.id))
      .leftJoin(fence, eq(fence.paddockId, paddock.id))
      .where(eq(paddock.slug, slug))
      .limit(1)
    const row = rows[0]
    if (!row) return null

    return {
      paddockId: row.paddock.id,
      orgId: row.paddock.orgId,
      slug: row.paddock.slug,
      status: row.paddock.status,
      breedId: row.flock.breed,
      flock: {
        baseUrl: row.flock.baseUrl,
        upstreamAuth: row.flock.upstreamAuth ?? null,
        tlsTrust: row.flock.tlsTrust,
      },
      fence: {
        constraintJson: row.fence?.constraintJson ?? {},
        rateLimit: (row.fence?.rateLimit as RateLimit | null) ?? null,
        quota: row.fence?.quota ?? null,
      },
    }
  }
}
```
_(The unused `and` import is a mistake — do NOT include it; import only `eq`.)_

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm test config-store`
Expected: PASS — all 4 ConfigStore tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/data-plane/package.json apps/data-plane/tsconfig.json apps/data-plane/src/config apps/data-plane/test tsconfig.json pnpm-lock.yaml
git commit -m "feat(data-plane): ConfigStore over Drizzle (key + paddock resolution)"
```

---

### Task 4: In-memory rate limiter

**Files:**
- Create: `apps/data-plane/src/ratelimit/rate-limiter.ts`
- Test: `apps/data-plane/test/rate-limiter.test.ts`

**Interfaces:**
- Consumes: `RateLimit` from `../config/types.js`.
- Produces:
  - `interface RateLimitResult { allowed: boolean; retryAfterSec: number }`.
  - `interface RateLimiter { check(bucketKey: string, limit: RateLimit): Promise<RateLimitResult> }`.
  - `class InMemoryRateLimiter implements RateLimiter` — sliding-window log; constructor accepts `{ now?: () => number }` (default `Date.now`) for deterministic tests. On `check`: drop timestamps older than `windowSec*1000`; if remaining count `< max`, record `now` and return `{allowed:true, retryAfterSec:0}`; else return `{allowed:false, retryAfterSec}` where `retryAfterSec = ceil((oldest + windowMs - now)/1000)`.

- [ ] **Step 1: Write the failing test**

`apps/data-plane/test/rate-limiter.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import { InMemoryRateLimiter } from '../src/ratelimit/rate-limiter.js'

describe('InMemoryRateLimiter', () => {
  test('allows up to max within the window, then blocks', async () => {
    let t = 1_000_000
    const rl = new InMemoryRateLimiter({ now: () => t })
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
    const rl = new InMemoryRateLimiter({ now: () => t })
    const limit = { windowSec: 60, max: 1 }
    expect((await rl.check('a', limit)).allowed).toBe(true)
    expect((await rl.check('b', limit)).allowed).toBe(true)
    expect((await rl.check('a', limit)).allowed).toBe(false)
  })

  test('the window slides: old hits expire', async () => {
    let t = 0
    const rl = new InMemoryRateLimiter({ now: () => t })
    const limit = { windowSec: 10, max: 1 }
    expect((await rl.check('k', limit)).allowed).toBe(true)
    t = 11_000
    expect((await rl.check('k', limit)).allowed).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test rate-limiter`
Expected: FAIL — cannot resolve `../src/ratelimit/rate-limiter.js`.

- [ ] **Step 3: Write the limiter**

`apps/data-plane/src/ratelimit/rate-limiter.ts`:
```ts
import type { RateLimit } from '../config/types.js'

export interface RateLimitResult {
  allowed: boolean
  retryAfterSec: number
}

export interface RateLimiter {
  check(bucketKey: string, limit: RateLimit): Promise<RateLimitResult>
}

export class InMemoryRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, number[]>()
  private readonly now: () => number

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now())
  }

  async check(bucketKey: string, limit: RateLimit): Promise<RateLimitResult> {
    const now = this.now()
    const windowMs = limit.windowSec * 1000
    const cutoff = now - windowMs
    const recent = (this.hits.get(bucketKey) ?? []).filter((t) => t > cutoff)

    if (recent.length < limit.max) {
      recent.push(now)
      this.hits.set(bucketKey, recent)
      return { allowed: false, retryAfterSec: 0 } === undefined
        ? { allowed: true, retryAfterSec: 0 }
        : { allowed: true, retryAfterSec: 0 }
    }

    this.hits.set(bucketKey, recent)
    const oldest = recent[0]
    const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000))
    return { allowed: false, retryAfterSec }
  }
}
```
_(Simplify the allowed branch to just `return { allowed: true, retryAfterSec: 0 }` — the ternary above is deliberately silly to make you delete it and write the clean line.)_

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test rate-limiter`
Expected: PASS — all 3 rate-limiter tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/data-plane/src/ratelimit apps/data-plane/test/rate-limiter.test.ts
git commit -m "feat(data-plane): in-memory sliding-window rate limiter"
```

---

### Task 5: MeterSink + fake Ollama upstream

**Files:**
- Create: `apps/data-plane/src/meter/meter-sink.ts`
- Create: `apps/data-plane/test/helpers/fake-ollama.ts`
- Test: `apps/data-plane/test/meter-sink.test.ts`

**Interfaces:**
- Consumes: `MeterDim` from `@metamodels/schema`.
- Produces:
  - `interface MeterEventRecord { orgId: string; keyId: string; paddockId: string; breedId: string; dim: MeterDim; value: number; at: number }`.
  - `interface MeterSink { emit(events: MeterEventRecord[]): Promise<void> }`.
  - `class InMemoryMeterSink implements MeterSink` with a public `readonly events: MeterEventRecord[]` it appends to.
  - `createFakeOllama(): Hono` — a Hono app simulating Ollama, routed to via an injected `fetchImpl`. Endpoints: `GET /api/version` → `{version:'test'}`; `GET /api/tags` → one model `llama3.2:1b`; `POST /api/chat` → NDJSON stream: two `{message:{content},done:false}` lines then a final `{done:true, prompt_eval_count:11, eval_count:22}` (or a single JSON object when `stream===false`); `POST /api/generate` → similar with `response`; `POST /api/embed` → `{embeddings:[[0.1]], prompt_eval_count:5}`; `POST /v1/chat/completions` → OpenAI-shaped, includes a `usage` object; `POST /api/pull` → `{status:'success'}` (should never be reached — proves guard denies before upstream).

- [ ] **Step 1: Write the failing test**

`apps/data-plane/test/meter-sink.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import { InMemoryMeterSink } from '../src/meter/meter-sink.js'
import { createFakeOllama } from './helpers/fake-ollama.js'

describe('InMemoryMeterSink', () => {
  test('accumulates emitted records', async () => {
    const sink = new InMemoryMeterSink()
    await sink.emit([{ orgId: 'o', keyId: 'k', paddockId: 'p', breedId: 'ollama', dim: 'tokens_in', value: 3, at: 1 }])
    await sink.emit([{ orgId: 'o', keyId: 'k', paddockId: 'p', breedId: 'ollama', dim: 'tokens_out', value: 4, at: 2 }])
    expect(sink.events).toHaveLength(2)
    expect(sink.events.map((e) => e.dim)).toEqual(['tokens_in', 'tokens_out'])
  })
})

describe('createFakeOllama', () => {
  test('streams NDJSON chat with a final counts frame', async () => {
    const app = createFakeOllama()
    const res = await app.request('http://fake.ollama/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'llama3.2:1b', messages: [] }),
    })
    const text = await res.text()
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
    const final = JSON.parse(lines[lines.length - 1])
    expect(final.done).toBe(true)
    expect(final.prompt_eval_count).toBe(11)
    expect(final.eval_count).toBe(22)
  })

  test('exposes /api/version', async () => {
    const res = await createFakeOllama().request('http://fake.ollama/api/version')
    expect(await res.json()).toEqual({ version: 'test' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test meter-sink`
Expected: FAIL — cannot resolve `../src/meter/meter-sink.js`.

- [ ] **Step 3: Write the sink + fake upstream**

`apps/data-plane/src/meter/meter-sink.ts`:
```ts
import type { MeterDim } from '@metamodels/schema'

export interface MeterEventRecord {
  orgId: string
  keyId: string
  paddockId: string
  breedId: string
  dim: MeterDim
  value: number
  at: number
}

export interface MeterSink {
  emit(events: MeterEventRecord[]): Promise<void>
}

export class InMemoryMeterSink implements MeterSink {
  readonly events: MeterEventRecord[] = []

  async emit(events: MeterEventRecord[]): Promise<void> {
    this.events.push(...events)
  }
}
```

`apps/data-plane/test/helpers/fake-ollama.ts`:
```ts
import { Hono } from 'hono'

function ndjson(lines: unknown[]): Response {
  const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
}

export function createFakeOllama(): Hono {
  const app = new Hono()

  app.get('/api/version', (c) => c.json({ version: 'test' }))
  app.get('/api/tags', (c) =>
    c.json({ models: [{ name: 'llama3.2:1b', model: 'llama3.2:1b', size: 1234, details: { parameter_size: '1.2B' } }] }),
  )

  app.post('/api/chat', async (c) => {
    const body = await c.req.json<{ stream?: boolean }>()
    const finalFrame = { model: 'llama3.2:1b', done: true, done_reason: 'stop', prompt_eval_count: 11, eval_count: 22 }
    if (body.stream === false) return c.json(finalFrame)
    return ndjson([
      { message: { role: 'assistant', content: 'Hel' }, done: false },
      { message: { role: 'assistant', content: 'lo' }, done: false },
      finalFrame,
    ])
  })

  app.post('/api/generate', async (c) => {
    const body = await c.req.json<{ stream?: boolean }>()
    const finalFrame = { done: true, response: '', prompt_eval_count: 9, eval_count: 13 }
    if (body.stream === false) return c.json({ response: 'hi', ...finalFrame })
    return ndjson([{ response: 'hi', done: false }, finalFrame])
  })

  app.post('/api/embed', (c) => c.json({ embeddings: [[0.1, 0.2]], prompt_eval_count: 5 }))

  app.post('/v1/chat/completions', (c) =>
    c.json({
      id: 'x', object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
    }),
  )

  // Should never be reached — guard denies model-management before proxying.
  app.post('/api/pull', (c) => c.json({ status: 'success' }))

  return app
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test meter-sink`
Expected: PASS — sink + fake-ollama tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/data-plane/src/meter apps/data-plane/test/helpers/fake-ollama.ts apps/data-plane/test/meter-sink.test.ts
git commit -m "feat(data-plane): in-memory meter sink + fake ollama test upstream"
```

---

### Task 6: Streaming proxy with final-frame capture

**Files:**
- Create: `apps/data-plane/src/proxy/proxy.ts`
- Test: `apps/data-plane/test/proxy.test.ts`

**Interfaces:**
- Consumes: `RewrittenRequest`, `UpstreamResult` from `@metamodels/connectors`.
- Produces:
  - `interface ProxyResult { response: Response; metering: Promise<UpstreamResult> }`.
  - `type FetchImpl = (url: string, init: RequestInit) => Promise<Response>`.
  - `async function proxyToUpstream(flock: { baseUrl: string; upstreamAuth: string | null; tlsTrust?: boolean }, req: RewrittenRequest, opts?: { fetchImpl?: FetchImpl }): Promise<ProxyResult>` — builds `baseUrl + req.path`, forwards method/headers/body (JSON-serialized for non-GET), and **tees** the streamed body: one branch becomes `response` for the client, the other is read to completion to produce `metering` (an `UpstreamResult` whose `finalFrame` is the last non-empty JSON-parseable NDJSON line, and whose `body` is the whole-response JSON when it parses as a single object). Non-streamed/empty bodies resolve `metering` from the buffered text.

- [ ] **Step 1: Write the failing test**

`apps/data-plane/test/proxy.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import { proxyToUpstream } from '../src/proxy/proxy.js'
import { createFakeOllama } from './helpers/fake-ollama.js'

const flock = { baseUrl: 'http://fake.ollama', upstreamAuth: null }
const fetchImpl = (() => {
  const app = createFakeOllama()
  return (url: string, init: RequestInit) => app.request(url, init)
})()

describe('proxyToUpstream', () => {
  test('streams the NDJSON body to the client unchanged', async () => {
    const { response } = await proxyToUpstream(flock, {
      method: 'POST', path: '/api/chat', headers: { 'content-type': 'application/json' },
      body: { model: 'llama3.2:1b', messages: [] },
    }, { fetchImpl })
    const text = await response.text()
    expect(text).toContain('"done":true')
    expect(text.split('\n').filter(Boolean).length).toBe(3)
  })

  test('captures the final NDJSON frame for metering', async () => {
    const { metering } = await proxyToUpstream(flock, {
      method: 'POST', path: '/api/chat', headers: { 'content-type': 'application/json' },
      body: { model: 'llama3.2:1b', messages: [] },
    }, { fetchImpl })
    const up = await metering
    expect(up.status).toBe(200)
    expect((up.finalFrame as { eval_count: number }).eval_count).toBe(22)
  })

  test('captures a single JSON object for non-streaming responses', async () => {
    const { metering } = await proxyToUpstream(flock, {
      method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' },
      body: { model: 'llama3.2:1b', stream: false },
    }, { fetchImpl })
    const up = await metering
    expect((up.body as { usage: { prompt_tokens: number } }).usage.prompt_tokens).toBe(7)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test proxy`
Expected: FAIL — cannot resolve `../src/proxy/proxy.js`.

- [ ] **Step 3: Write the proxy**

`apps/data-plane/src/proxy/proxy.ts`:
```ts
import type { RewrittenRequest, UpstreamResult } from '@metamodels/connectors'

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>

export interface ProxyResult {
  response: Response
  metering: Promise<UpstreamResult>
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  h.forEach((value, key) => {
    out[key] = value
  })
  return out
}

async function readOutcome(
  stream: ReadableStream<Uint8Array>,
  status: number,
  headers: Record<string, string>,
): Promise<UpstreamResult> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) buffer += decoder.decode(value, { stream: true })
  }
  buffer += decoder.decode()

  const lines = buffer.split('\n').map((l) => l.trim()).filter(Boolean)
  let finalFrame: unknown
  for (let i = lines.length - 1; i >= 0; i--) {
    const parsed = tryParse(lines[i])
    if (parsed !== undefined) {
      finalFrame = parsed
      break
    }
  }
  const whole = tryParse(buffer)
  return { status, headers, body: whole ?? finalFrame, finalFrame }
}

export async function proxyToUpstream(
  flock: { baseUrl: string; upstreamAuth: string | null; tlsTrust?: boolean },
  req: RewrittenRequest,
  opts: { fetchImpl?: FetchImpl } = {},
): Promise<ProxyResult> {
  const doFetch = opts.fetchImpl ?? ((url, init) => fetch(url, init))
  const url = flock.baseUrl.replace(/\/$/, '') + req.path

  const headers: Record<string, string> = { ...req.headers }
  if (flock.upstreamAuth) headers['authorization'] = `Bearer ${flock.upstreamAuth}`

  const init: RequestInit = { method: req.method, headers }
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined) {
    init.body = JSON.stringify(req.body)
    headers['content-type'] = headers['content-type'] ?? 'application/json'
  }

  const upstream = await doFetch(url, init)
  const outHeaders = headersToObject(upstream.headers)

  if (!upstream.body) {
    const text = await upstream.text()
    const whole = tryParse(text)
    return {
      response: new Response(text, { status: upstream.status, headers: outHeaders }),
      metering: Promise.resolve({ status: upstream.status, headers: outHeaders, body: whole, finalFrame: whole }),
    }
  }

  const [toClient, toMeter] = upstream.body.tee()
  return {
    response: new Response(toClient, { status: upstream.status, headers: outHeaders }),
    metering: readOutcome(toMeter, upstream.status, outHeaders),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test proxy`
Expected: PASS — all 3 proxy tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/data-plane/src/proxy apps/data-plane/test/proxy.test.ts
git commit -m "feat(data-plane): streaming proxy with teed final-frame capture"
```

---

### Task 7: The data-plane app (auth → limit → guard → proxy → meter)

**Files:**
- Create: `apps/data-plane/src/breeds.ts`, `apps/data-plane/src/app.ts`
- Test: `apps/data-plane/test/app.integration.test.ts`

**Interfaces:**
- Consumes: everything above — `ConfigStore`, `RateLimiter`, `MeterSink`/`MeterEventRecord`, `proxyToUpstream`/`FetchImpl`, `BreedRegistry`, `ollamaBreed`, `hashApiKey`, `RequestCtx`.
- Produces:
  - `buildRegistry(): BreedRegistry` — a registry with `ollamaBreed` registered.
  - `interface AppDeps { configStore: ConfigStore; rateLimiter: RateLimiter; meterSink: MeterSink; registry: BreedRegistry; fetchImpl?: FetchImpl; defaultRateLimit?: RateLimit }`.
  - `function createApp(deps: AppDeps): { app: Hono; drainMeters: () => Promise<void> }` — mounts `ALL /p/:slug/*`; `drainMeters()` awaits all in-flight metering tasks (so tests are deterministic). Default rate limit `{ windowSec: 60, max: 60 }`.

- [ ] **Step 1: Write the failing test**

`apps/data-plane/test/app.integration.test.ts`:
```ts
import { beforeEach, describe, expect, test } from 'vitest'
import { createApp } from '../src/app.js'
import { buildRegistry } from '../src/breeds.js'
import { DrizzleConfigStore } from '../src/config/config-store.js'
import { InMemoryRateLimiter } from '../src/ratelimit/rate-limiter.js'
import { InMemoryMeterSink } from '../src/meter/meter-sink.js'
import { createFakeOllama } from './helpers/fake-ollama.js'
import { makeDb, seedFixture, type Fixture } from './helpers/seed.js'

let fx: Fixture
let sink: InMemoryMeterSink
let app: ReturnType<typeof createApp>['app']
let drainMeters: () => Promise<void>

beforeEach(async () => {
  const db = await makeDb()
  fx = await seedFixture(db)
  sink = new InMemoryMeterSink()
  const fake = createFakeOllama()
  const built = createApp({
    configStore: new DrizzleConfigStore(db),
    rateLimiter: new InMemoryRateLimiter(),
    meterSink: sink,
    registry: buildRegistry(),
    fetchImpl: (url, init) => fake.request(url, init),
  })
  app = built.app
  drainMeters = built.drainMeters
})

function call(path: string, init: RequestInit = {}, key = fx.keyPlaintext) {
  const headers = new Headers(init.headers)
  if (key) headers.set('authorization', `Bearer ${key}`)
  return app.request(`http://dp.local${path}`, { ...init, headers })
}
const chat = (model: string) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }),
})

describe('data-plane /p/:slug', () => {
  test('401 without a key', async () => {
    const res = await call('/p/small/api/chat', { ...chat('llama3.2:1b') }, '')
    expect(res.status).toBe(401)
  })

  test('401 with an unknown key', async () => {
    const res = await call('/p/small/api/chat', chat('llama3.2:1b'), 'mm_live_wrong')
    expect(res.status).toBe(401)
  })

  test('404 for an unknown paddock slug', async () => {
    const res = await call('/p/ghost/api/chat', chat('llama3.2:1b'))
    expect(res.status).toBe(404)
  })

  test('403 for a model-management (MUTATE) route, without hitting upstream', async () => {
    const res = await call('/p/small/api/pull', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'llama3' }),
    })
    expect(res.status).toBe(403)
  })

  test('403 for a model not on the allowlist', async () => {
    const res = await call('/p/small/api/chat', chat('llama3:70b'))
    expect(res.status).toBe(403)
  })

  test('200 for an allowed model, streams NDJSON, and meters tokens', async () => {
    const res = await call('/p/small/api/chat', chat('llama3.2:1b'))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('"done":true')
    await drainMeters()
    const dims = Object.fromEntries(sink.events.map((e) => [e.dim, e.value]))
    expect(dims).toEqual({ tokens_in: 11, tokens_out: 22 })
    expect(sink.events[0]).toMatchObject({ orgId: fx.orgId, keyId: fx.keyId, paddockId: fx.paddockId, breedId: 'ollama' })
  })

  test('429 once the fence rate limit (max 5/60s) is exceeded', async () => {
    for (let i = 0; i < 5; i++) {
      const ok = await call('/p/small/api/chat', chat('llama3.2:1b'))
      expect(ok.status).toBe(200)
      await ok.text()
    }
    const limited = await call('/p/small/api/chat', chat('llama3.2:1b'))
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBeTruthy()
    await drainMeters()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test app.integration`
Expected: FAIL — cannot resolve `../src/app.js`.

- [ ] **Step 3: Write the registry + app**

`apps/data-plane/src/breeds.ts`:
```ts
import { BreedRegistry, ollamaBreed } from '@metamodels/connectors'

export function buildRegistry(): BreedRegistry {
  const registry = new BreedRegistry()
  registry.register(ollamaBreed)
  return registry
}
```

`apps/data-plane/src/app.ts`:
```ts
import { Hono } from 'hono'
import type { BreedRegistry, RequestCtx } from '@metamodels/connectors'
import { hashApiKey } from '@metamodels/schema'
import type { ConfigStore } from './config/config-store.js'
import type { RateLimit } from './config/types.js'
import type { RateLimiter } from './ratelimit/rate-limiter.js'
import type { MeterSink } from './meter/meter-sink.js'
import { proxyToUpstream, type FetchImpl } from './proxy/proxy.js'

export interface AppDeps {
  configStore: ConfigStore
  rateLimiter: RateLimiter
  meterSink: MeterSink
  registry: BreedRegistry
  fetchImpl?: FetchImpl
  defaultRateLimit?: RateLimit
}

const DEFAULT_RATE_LIMIT: RateLimit = { windowSec: 60, max: 60 }

function extractKey(header: string | undefined, xApiKey: string | undefined): string | null {
  if (header && header.startsWith('Bearer ')) return header.slice('Bearer '.length).trim()
  if (xApiKey) return xApiKey.trim()
  return null
}

export function createApp(deps: AppDeps): { app: Hono; drainMeters: () => Promise<void> } {
  const app = new Hono()
  const defaultLimit = deps.defaultRateLimit ?? DEFAULT_RATE_LIMIT
  const pending = new Set<Promise<void>>()

  app.all('/p/:slug/*', async (c) => {
    const slug = c.req.param('slug')
    const upstreamPath = '/' + c.req.path.split('/').slice(3).join('/')

    // 1. Authenticate
    const plaintext = extractKey(c.req.header('authorization'), c.req.header('x-api-key'))
    if (!plaintext) return c.json({ error: 'missing api key' }, 401)
    const resolvedKey = await deps.configStore.resolveKeyByHash(hashApiKey(plaintext))
    if (!resolvedKey) return c.json({ error: 'invalid api key' }, 401)
    if (resolvedKey.expiresAt && resolvedKey.expiresAt.getTime() < Date.now()) {
      return c.json({ error: 'expired api key' }, 401)
    }

    // 2. Resolve paddock
    const paddock = await deps.configStore.getPaddockBySlug(slug)
    if (!paddock || paddock.status !== 'active') return c.json({ error: 'unknown paddock' }, 404)
    if (!resolvedKey.paddockSlugs.includes(slug)) return c.json({ error: 'key not scoped to paddock' }, 403)

    const breed = deps.registry.get(paddock.breedId)

    // 3. Rate limit
    const limit = resolvedKey.overrides?.rateLimit ?? paddock.fence.rateLimit ?? defaultLimit
    const rl = await deps.rateLimiter.check(`${resolvedKey.keyId}:${paddock.paddockId}`, limit)
    if (!rl.allowed) {
      c.header('retry-after', String(rl.retryAfterSec))
      return c.json({ error: 'rate limit exceeded' }, 429)
    }

    // 4. Parse body + build context
    let body: unknown
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      body = await c.req.json().catch(() => undefined)
    }
    const ctx: RequestCtx = {
      method: c.req.method,
      path: upstreamPath,
      headers: { 'content-type': 'application/json' },
      body,
      paddockSlug: slug,
    }

    // 5. Guard
    const fence = breed.constraintSchema.parse(paddock.fence.constraintJson)
    const guard = await breed.guard(ctx, fence)
    if (!guard.ok) return c.json({ error: guard.reason }, guard.status)

    // 6. Proxy + meter (fire-and-forget metering, drainable for tests)
    const { response, metering } = await proxyToUpstream(paddock.flock, guard.request, { fetchImpl: deps.fetchImpl })
    const meterTask = metering
      .then((upstream) => {
        const events = breed.meter(ctx, upstream).map((e) => ({
          orgId: paddock.orgId, keyId: resolvedKey.keyId, paddockId: paddock.paddockId,
          breedId: paddock.breedId, dim: e.dim, value: e.value, at: e.at,
        }))
        return events.length ? deps.meterSink.emit(events) : undefined
      })
      .catch(() => undefined)
      .then(() => undefined)
    pending.add(meterTask)
    meterTask.finally(() => pending.delete(meterTask))

    return response
  })

  return { app, drainMeters: async () => { await Promise.all([...pending]) } }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test app.integration`
Expected: PASS — all 7 integration cases pass (401×2, 404, 403×2, 200+meter, 429).

- [ ] **Step 5: Commit**

```bash
git add apps/data-plane/src/breeds.ts apps/data-plane/src/app.ts apps/data-plane/test/app.integration.test.ts
git commit -m "feat(data-plane): request lifecycle app (auth, limit, guard, proxy, meter)"
```

---

### Task 8: Runtime bootstrap (server + env)

**Files:**
- Create: `apps/data-plane/src/server.ts`, `apps/data-plane/.env.example`, `apps/data-plane/README.md`
- Modify: `apps/data-plane/package.json` (add `@hono/node-server`, `postgres` deps; add `dev`/`start` scripts)
- Test: `apps/data-plane/test/server-config.test.ts`

**Interfaces:**
- Consumes: `createApp`, `buildRegistry`, `DrizzleConfigStore`, `InMemoryRateLimiter`, `InMemoryMeterSink`.
- Produces: `loadServerConfig(env: Record<string, string | undefined>): { databaseUrl: string; port: number }` (throws a clear error if `DATABASE_URL` is missing; `PORT` defaults to `8787`). `server.ts` wires the real deps and calls `serve`. Only `loadServerConfig` is unit-tested; the listening server is not started in tests.

- [ ] **Step 1: Write the failing test**

`apps/data-plane/test/server-config.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import { loadServerConfig } from '../src/server.js'

describe('loadServerConfig', () => {
  test('reads DATABASE_URL and defaults PORT to 8787', () => {
    const cfg = loadServerConfig({ DATABASE_URL: 'postgres://x/y' })
    expect(cfg).toEqual({ databaseUrl: 'postgres://x/y', port: 8787 })
  })

  test('honors PORT when set', () => {
    expect(loadServerConfig({ DATABASE_URL: 'postgres://x/y', PORT: '9000' }).port).toBe(9000)
  })

  test('throws a clear error when DATABASE_URL is missing', () => {
    expect(() => loadServerConfig({})).toThrow(/DATABASE_URL/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test server-config`
Expected: FAIL — cannot resolve `../src/server.js`.

- [ ] **Step 3: Add deps + write server**

Add to `apps/data-plane/package.json`:
```json
"scripts": {
  "dev": "tsx watch src/server.ts",
  "start": "tsx src/server.ts"
},
```
and dependencies `"@hono/node-server": "^1.13.0"`, `"postgres": "^3.4.0"`, devDependency `"tsx": "^4.19.0"`. Run `pnpm install`.

`apps/data-plane/src/server.ts`:
```ts
import { serve } from '@hono/node-server'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from '@metamodels/schema'
import { createApp } from './app.js'
import { buildRegistry } from './breeds.js'
import { DrizzleConfigStore } from './config/config-store.js'
import { InMemoryRateLimiter } from './ratelimit/rate-limiter.js'
import { InMemoryMeterSink } from './meter/meter-sink.js'

export interface ServerConfig {
  databaseUrl: string
  port: number
}

export function loadServerConfig(env: Record<string, string | undefined>): ServerConfig {
  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  const port = env.PORT ? Number(env.PORT) : 8787
  return { databaseUrl, port }
}

export function startServer(cfg: ServerConfig): void {
  const sql = postgres(cfg.databaseUrl)
  const db = drizzle(sql, { schema })
  const { app } = createApp({
    configStore: new DrizzleConfigStore(db),
    rateLimiter: new InMemoryRateLimiter(),
    meterSink: new InMemoryMeterSink(),
    registry: buildRegistry(),
  })
  serve({ fetch: app.fetch, port: cfg.port })
  // eslint-disable-next-line no-console
  console.log(`metamodels data-plane listening on :${cfg.port}`)
}

// Only run when executed directly, not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  startServer(loadServerConfig(process.env))
}
```
_(Note: `InMemoryMeterSink`/`InMemoryRateLimiter` are placeholders for the runtime wiring in this milestone; Plan 4 replaces them with the Redis-backed sink/limiter. This is intentional — the data plane is runnable now, and swapping the two constructor args is the only change Plan 4 makes here.)_

`apps/data-plane/.env.example`:
```
DATABASE_URL=postgres://metamodels:metamodels@localhost:5432/metamodels
PORT=8787
```

`apps/data-plane/README.md`: a short doc — what the data plane does, the `ALL /p/:slug/*` contract, the `mm_live_` auth header, and `pnpm --filter @metamodels/data-plane dev` to run it (requires `DATABASE_URL` and migrations applied via `pnpm --filter @metamodels/schema db:migrate`).

- [ ] **Step 4: Run test + typecheck**

Run: `pnpm test server-config`
Expected: PASS.

Run: `pnpm test && pnpm typecheck`
Expected: full suite green; `tsc -b` exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/data-plane
git commit -m "feat(data-plane): runtime server bootstrap + env config + README"
```

---

## Plan 2 Self-Review

- **Spec coverage:** data-plane hot path (auth→limit→guard→proxy→meter) ✓ (Task 7); Ollama route classification + MUTATE hard-deny ✓ (Task 1); model allowlist ✓ (Task 1); `/v1` `include_usage` injection ✓ (Task 1); token metering from final NDJSON line + `/v1` usage ✓ (Task 2); NDJSON streaming passthrough via tee ✓ (Task 6); key hashing + paddock scoping ✓ (Tasks 3, 7); rate limiting + 429/Retry-After ✓ (Tasks 4, 7); `org_id`-keyed meter records ✓ (Tasks 5, 7); runnable server ✓ (Task 8). Redis-backed limiter/sink and quota caps are Plan 4 (per roadmap); the interfaces here are the swap points.
- **Placeholder scan:** no TBD/TODO. Two deliberate "delete-this" traps are called out in prose (the `and` import in Task 3; the silly ternary in Task 4) so the implementer writes the clean line — these are teaching notes, not shipped code. The `InMemoryMeterSink`/`InMemoryRateLimiter` runtime wiring in Task 8 is explicitly labeled as the Plan-4 swap point, not a stub of missing behavior.
- **Type consistency:** `ResolvedKey`/`ResolvedPaddock`/`RateLimit`/`RateLimitResult`/`MeterEventRecord`/`ProxyResult`/`FetchImpl`/`AppDeps` names are defined once and referenced consistently across Tasks 3–8; `ollamaBreed`/`ollamaConstraint`/`routeGroup`/`OllamaConstraint` match between Tasks 1–2 and the app in Task 7; `proxyToUpstream` signature is identical in Task 6 (definition) and Task 7 (call); `hashApiKey`, the schema tables, and `BreedRegistry`/`RequestCtx`/`UpstreamResult`/`MeterEvent` all come from Plan 1's already-shipped exports.

## Carry-forward consumed from Plan 1 review
- #4 (constraintSchema typing): resolved — interface stays `ZodTypeAny`; the Ollama breed authors a locally-typed `ollamaConstraint` and `guard(fence: OllamaConstraint)`. Documented in Global Constraints.
- #5 (async meter): validated for Ollama — the proxy collects the full outcome into `UpstreamResult` before the sync `meter()` runs, so the sync signature holds here. Re-checked for real in Plan 3 (ComfyUI) per that carry-forward.

## Next milestone
Plan 3 — ComfyUI breed (template model, graph reconstruction, image-upload param, scoped result endpoint, `/ws` metering). Expand via a fresh writing-plans pass after Plan 2 is merged.
