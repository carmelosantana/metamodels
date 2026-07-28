# MetaModels Plan 5.4 — Schema Hoist + API Keys (screen 9d) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hoist the duplicated fence-config Zod schemas and the client-safe graph-parse helpers into `@metamodels/schema` (via genuinely client-safe subpath exports), then build the API-Keys management screen (9d) — mint a `mm_live_` key whose plaintext is shown exactly once, scope it to org-owned paddocks with enforced org consistency, optionally set a per-key rate override, and revoke it — all org-scoped, capability-gated, tx+audit.

**Architecture:** Two phases. **Phase A (hoist, Tasks 1–2)** eliminates the hand-copied `rateLimitSchema`/`quotaRuleSchema`/`quotaSchema` drift risk (Plan 5.2 carry-forward Minor) and makes the "client bundle must not pull `node:crypto`" boundary *structural* rather than convention-only (Plan 5.3 whole-branch advisory). The hoist targets are **subpath exports** — `@metamodels/schema/config` and `@metamodels/schema/graph` — each a leaf module importing only `zod` (+ the package's own pure `enums.ts`), so their module graphs provably never reach `keys.ts`/`node:crypto`. The barrel (`@metamodels/schema`) stays server-only. **Phase B (keys, Tasks 3–5)** adds `keys-service.ts` (org-scoped, tx+audit, following the established CRUD template), enforcing key↔paddock org consistency with the same org-scoped-join pattern as `paddockBreedInOrg`, and screen 9d (`/keys`) with a shown-once plaintext reveal.

**Tech Stack:** TypeScript ESM (moduleResolution Bundler; `.js` import specifiers in shared packages), pnpm workspaces, Zod, Drizzle ORM + Postgres (pglite for tests), Next.js 16.2 (webpack, `transpilePackages` + `experimental.extensionAlias`), Vitest.

## Global Constraints

- **Node floor `>=24`; ESM only.** Shared packages (`@metamodels/schema`, `@metamodels/connectors`) use NodeNext-style `.js` import specifiers that resolve to `.ts` source; the Next app does NOT use `.js` specifiers within its own `src`.
- **No new runtime dependencies.** No new migration (the `apiKey` + `keyPaddock` tables and `generateApiKey`/`hashApiKey` already exist from Plan 1, migrations `0000`–`0003`).
- **API key format:** `mm_live_` prefix; stored **hashed** (SHA-256 hex) via `hashApiKey`; only the 12-char `prefix` and the hash persist. The plaintext is returned **exactly once** from `createKey` and is NEVER stored, logged, or written to the audit detail.
- **Client-bundle safety (structural, not convention):** `packages/schema/src/config.ts` and `packages/schema/src/graph.ts` MUST import only `zod` and the package's own pure modules (`enums.ts`). They MUST NOT import `node:crypto`, `./keys`, `./index`, `./schema`, or `@metamodels/connectors`. A guard test enforces this. Client components import these via the subpath (`@metamodels/schema/config`, `@metamodels/schema/graph`), never the barrel.
- **`graph.ts` is self-contained:** `@metamodels/connectors` depends on `@metamodels/schema`, so `schema` importing `connectors` (even type-only) is a forbidden cycle. `graph.ts` inlines its own `WorkflowGraph` type (structurally identical to the connector's `WorkflowTemplate['graph']`).
- **Security boundary is the server.** Every write server action re-checks `requireCapability(actor, 'resource.write')` server-side; UI `canWrite` hiding is convenience only. Capability check + Zod `.parse()` run BEFORE the `db.transaction`; the org-scoped read → mutation → `writeAudit(tx, …)` all run inside ONE transaction; `NotFoundError` is thrown INSIDE the tx on an empty `.returning()` (atomic rollback, no orphan audit).
- **Key↔paddock org consistency (the headline security property):** a key may only be scoped to paddocks in its own org. Enforced app-side with an org-scoped join (`paddock.orgId = actor.orgId`) at write time — `key_paddock` has no `org_id` column and no composite FK, and meter attribution downstream uses `paddock.orgId` while the data-plane scope check is slug-only, so a cross-org link would misattribute usage.
- **Git identity:** `Carmelo Santana <me@carmelosantana.com>`. Branch: `feat/metamodels-plan5.4`.
- **Test lanes:** root `pnpm test` (baseline 166 pass / 3 skip), control-plane `pnpm --filter @metamodels/control-plane exec vitest run` (baseline 85 pass), workspace typecheck `pnpm -w exec tsc -b`. Every task keeps all three green.

---

## File Structure

```
packages/schema/
  package.json                         # MODIFY: add "./config" + "./graph" subpath exports
  src/
    config.ts                          # CREATE: rateLimitSchema/quotaRuleSchema/quotaSchema (zod + enums only)
    graph.ts                           # CREATE: WorkflowGraph + graphSchema + parseGraphText/graphTargets/BuildResult
    index.ts                           # MODIFY: re-export ./config + ./graph from the barrel (server convenience)
  test/
    config.test.ts                     # CREATE: rate/quota shape tests
    graph.test.ts                      # CREATE: parse ok/bad-json/bad-graph + targets-sorted
    client-safe.test.ts                # CREATE: guard — config.ts + graph.ts import no forbidden module

apps/data-plane/src/config/
  quota.ts                             # MODIFY: re-export quotaRuleSchema/quotaSchema/QuotaRule from @metamodels/schema/config

apps/control-plane/src/
  lib/
    fence-schema.ts                    # MODIFY: import rate/quota schemas from @metamodels/schema/config
    template-schema.ts                 # MODIFY: re-export graphSchema from @metamodels/schema/graph (paramSpec/draft stay)
    graph-parse.ts                     # DELETE: superseded by @metamodels/schema/graph
    template-builder.ts                # MODIFY: import parse helpers from @metamodels/schema/graph (re-export preserved)
    key-schema.ts                      # CREATE: createKeyInput zod (name, paddockIds, expiresAt?, overrides?)
  server/
    keys-service.ts                    # CREATE: listKeys / createKey / revokeKey (org-scoped, tx+audit)
    keys-service.test.ts               # CREATE: service tests
  app/(app)/
    paddocks/[id]/templates/
      templates-client.tsx             # MODIFY: import parse helpers from @metamodels/schema/graph
    keys/
      page.tsx                         # CREATE: screen 9d server page (org-scoped list + paddock options)
      actions.ts                       # CREATE: createKeyAction (returns plaintext once) / revokeKeyAction
      keys-client.tsx                  # CREATE: list + mint drawer + shown-once reveal
  README.md                            # MODIFY: document the API Keys screen
```

---

### Task 1: Hoist rate/quota config schemas into a client-safe subpath

**Files:**
- Create: `packages/schema/src/config.ts`
- Create: `packages/schema/test/config.test.ts`
- Modify: `packages/schema/package.json` (add `./config` export)
- Modify: `packages/schema/src/index.ts` (re-export `./config.js`)
- Modify: `apps/data-plane/src/config/quota.ts` (re-export from subpath)
- Modify: `apps/control-plane/src/lib/fence-schema.ts` (import from subpath)

**Interfaces:**
- Consumes: `METER_DIMS` from `./enums.js` (same package); `zod`.
- Produces:
  - `@metamodels/schema/config` exports:
    - `rateLimitSchema: z.ZodObject<{ windowSec: ..., max: ... }>` — `{ windowSec: int().positive(), max: int().nonnegative() }`
    - `quotaRuleSchema: z.ZodObject<...>` — `{ dim: enum(METER_DIMS), max: int().nonnegative(), period: enum(['hour','day','month']) }`
    - `quotaSchema = z.array(quotaRuleSchema)`
    - `type RateLimitInput = z.infer<typeof rateLimitSchema>`
    - `type QuotaRule = z.infer<typeof quotaRuleSchema>`
  - The barrel `@metamodels/schema` also re-exports these (server-side convenience).

- [ ] **Step 1: Write the failing test**

`packages/schema/test/config.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import { rateLimitSchema, quotaRuleSchema, quotaSchema } from '../src/config.js'

describe('config schemas', () => {
  test('rateLimitSchema accepts a positive window + nonnegative max', () => {
    expect(rateLimitSchema.safeParse({ windowSec: 60, max: 100 }).success).toBe(true)
    expect(rateLimitSchema.safeParse({ windowSec: 60, max: 0 }).success).toBe(true)
  })

  test('rateLimitSchema rejects a non-positive window and a fractional max', () => {
    expect(rateLimitSchema.safeParse({ windowSec: 0, max: 1 }).success).toBe(false)
    expect(rateLimitSchema.safeParse({ windowSec: 60, max: 1.5 }).success).toBe(false)
    expect(rateLimitSchema.safeParse({ windowSec: 60, max: -1 }).success).toBe(false)
  })

  test('quotaRuleSchema binds a known meter dim + period', () => {
    expect(quotaRuleSchema.safeParse({ dim: 'tokens_in', max: 1000, period: 'day' }).success).toBe(true)
    expect(quotaRuleSchema.safeParse({ dim: 'not_a_dim', max: 1000, period: 'day' }).success).toBe(false)
    expect(quotaRuleSchema.safeParse({ dim: 'tokens_in', max: 1000, period: 'week' }).success).toBe(false)
  })

  test('quotaSchema is a list of rules', () => {
    expect(quotaSchema.safeParse([{ dim: 'jobs', max: 5, period: 'hour' }]).success).toBe(true)
    expect(quotaSchema.safeParse([]).success).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @metamodels/schema exec vitest run test/config.test.ts`
Expected: FAIL — `Cannot find module '../src/config.js'`.

- [ ] **Step 3: Create `config.ts`**

`packages/schema/src/config.ts`:
```ts
import { z } from 'zod'
import { METER_DIMS } from './enums.js'

// Client-safe: imports only zod + the package's pure enums (no node:crypto, no drizzle).
// The single source of truth for a fence's rate-limit + quota config shapes, consumed by
// BOTH the control-plane (fence-schema.ts) and the data-plane (config/quota.ts).

/** A fence's `rate_limit` column: a sliding window cap. `max: 0` = deny-all (both planes honor it). */
export const rateLimitSchema = z.object({
  windowSec: z.number().int().positive(),
  max: z.number().int().nonnegative(),
})
export type RateLimitInput = z.infer<typeof rateLimitSchema>

/** One hard cap on a single meter dimension per period. */
export const quotaRuleSchema = z.object({
  dim: z.enum(METER_DIMS),
  max: z.number().int().nonnegative(),
  period: z.enum(['hour', 'day', 'month']),
})
export type QuotaRule = z.infer<typeof quotaRuleSchema>

/** A fence's `quota` column: a list of per-dimension caps. */
export const quotaSchema = z.array(quotaRuleSchema)
```

- [ ] **Step 4: Add the subpath export**

Modify `packages/schema/package.json` — replace the `"exports"` block:
```json
  "exports": {
    ".": "./src/index.ts",
    "./config": "./src/config.ts",
    "./graph": "./src/graph.ts"
  },
```
(The `./graph` entry is consumed in Task 2; declaring it now keeps the two hoist tasks from thrashing `package.json`. The file it points at is created in Task 2 — that is fine, nothing imports `@metamodels/schema/graph` until then.)

- [ ] **Step 5: Re-export from the barrel**

Modify `packages/schema/src/index.ts` — add these two lines (keep the rest):
```ts
export * from './config.js'
```
(Do NOT add `./graph.js` to the barrel yet — Task 2 creates that file and adds its barrel line, so the barrel never references a missing module mid-task.)

- [ ] **Step 6: Run the config test to verify it passes**

Run: `pnpm --filter @metamodels/schema exec vitest run test/config.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 7: Rewire the data-plane to the hoisted schema**

Replace the entire body of `apps/data-plane/src/config/quota.ts`:
```ts
// The rate-limit + quota config shapes live in @metamodels/schema/config (the single
// source of truth shared with the control-plane). Re-exported here so existing importers
// (app.ts) keep their import path.
export { quotaRuleSchema, quotaSchema } from '@metamodels/schema/config'
export type { QuotaRule } from '@metamodels/schema/config'
```

- [ ] **Step 8: Rewire the control-plane fence schema**

Modify `apps/control-plane/src/lib/fence-schema.ts` — replace the local rate/quota declarations while keeping `saveFenceInput` and the `RateLimitInput`/`QuotaRuleInput` type names local importers rely on:
```ts
import { z } from 'zod'
import { rateLimitSchema, quotaSchema } from '@metamodels/schema/config'

export { rateLimitSchema, quotaSchema }
export type RateLimitInput = z.infer<typeof rateLimitSchema>
export type QuotaRuleInput = z.infer<typeof quotaSchema.element>

export const saveFenceInput = z.object({
  paddockId: z.string().uuid(),
  // Optional: when omitted, saveFence preserves the fence's stored constraint
  // (or applies the breed default on a fresh row). Validated per-breed on write.
  constraintJson: z.unknown().optional(),
  rateLimit: rateLimitSchema.nullish(),
  quota: quotaSchema.nullish(),
})
export type SaveFenceInput = z.infer<typeof saveFenceInput>
```

- [ ] **Step 9: Run every lane to verify the rewire is behavior-preserving**

Run: `pnpm -w exec tsc -b`
Expected: clean (no errors).

Run: `pnpm test`
Expected: root suite green — 170 pass / 3 skip (166 baseline + 4 new config tests).

Run: `pnpm --filter @metamodels/control-plane exec vitest run`
Expected: 85 pass (unchanged — the fence rewire is a pure re-point).

- [ ] **Step 10: Commit**

```bash
git add packages/schema apps/data-plane/src/config/quota.ts apps/control-plane/src/lib/fence-schema.ts
git commit -m "refactor(schema): hoist rate/quota config schemas to @metamodels/schema/config"
```

---

### Task 2: Hoist graphSchema + graph-parse into a client-safe subpath

**Files:**
- Create: `packages/schema/src/graph.ts`
- Create: `packages/schema/test/graph.test.ts`
- Create: `packages/schema/test/client-safe.test.ts` (structural guard for both `config.ts` + `graph.ts`)
- Modify: `packages/schema/src/index.ts` (re-export `./graph.js`)
- Modify: `apps/control-plane/src/lib/template-schema.ts` (re-export `graphSchema` from subpath)
- Modify: `apps/control-plane/src/lib/template-builder.ts` (import/re-export parse helpers from subpath)
- Modify: `apps/control-plane/src/app/(app)/paddocks/[id]/templates/templates-client.tsx` (import from subpath)
- Delete: `apps/control-plane/src/lib/graph-parse.ts`

**Interfaces:**
- Consumes: `zod` only. Inlines its own graph type (no `@metamodels/connectors` import — cycle).
- Produces `@metamodels/schema/graph` exports:
  - `type WorkflowGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>`
  - `graphSchema: z.ZodType<WorkflowGraph>`
  - `type BuildResult<T> = { ok: true; value: T } | { ok: false; reason: string }`
  - `parseGraphText(text: string): BuildResult<WorkflowGraph>`
  - `graphTargets(graph: WorkflowGraph): { node: string; inputs: string[] }[]`
- `template-schema.ts` re-exports `graphSchema`; `template-builder.ts` re-exports `parseGraphText`/`graphTargets`/`BuildResult` (API-preserving — Task-2/3 of Plan 5.3's tests and the client keep working).

- [ ] **Step 1: Write the failing test**

`packages/schema/test/graph.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import { parseGraphText, graphTargets } from '../src/graph.js'

const GOOD = JSON.stringify({
  '3': { class_type: 'KSampler', inputs: { seed: 0, steps: 20 } },
  '1': { class_type: 'CheckpointLoader', inputs: { ckpt_name: 'x.safetensors' } },
})

describe('graph parse helpers', () => {
  test('parses a valid workflow-API graph', () => {
    const r = parseGraphText(GOOD)
    expect(r.ok).toBe(true)
    if (r.ok) expect(Object.keys(r.value)).toHaveLength(2)
  })

  test('rejects invalid JSON with a friendly reason', () => {
    const r = parseGraphText('{ not json')
    expect(r).toEqual({ ok: false, reason: 'graph is not valid JSON' })
  })

  test('rejects a structurally-wrong graph', () => {
    const r = parseGraphText(JSON.stringify({ '3': { inputs: {} } })) // missing class_type
    expect(r.ok).toBe(false)
  })

  test('graphTargets enumerates node ids and input keys, both sorted', () => {
    const r = parseGraphText(GOOD)
    if (!r.ok) throw new Error('expected ok')
    expect(graphTargets(r.value)).toEqual([
      { node: '1', inputs: ['ckpt_name'] },
      { node: '3', inputs: ['seed', 'steps'] },
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @metamodels/schema exec vitest run test/graph.test.ts`
Expected: FAIL — `Cannot find module '../src/graph.js'`.

- [ ] **Step 3: Create `graph.ts`**

`packages/schema/src/graph.ts`:
```ts
import { z } from 'zod'

// Client-safe: imports only zod. The graph type is inlined (structurally identical to the
// connector's WorkflowTemplate['graph']) because @metamodels/connectors depends on this
// package — importing it here, even type-only, would be a cycle.

/** A ComfyUI workflow-API graph: node id → { class_type, inputs }. */
export type WorkflowGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>

export const graphSchema: z.ZodType<WorkflowGraph> = z.record(
  z.object({ class_type: z.string().min(1), inputs: z.record(z.unknown()) }),
) as z.ZodType<WorkflowGraph>

export type BuildResult<T> = { ok: true; value: T } | { ok: false; reason: string }

/** Parse pasted workflow-API JSON into a validated graph, or a friendly reason. Never throws. */
export function parseGraphText(text: string): BuildResult<WorkflowGraph> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'graph is not valid JSON' }
  }
  const parsed = graphSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, reason: 'not a valid workflow-API graph (each node needs class_type + inputs)' }
  }
  return { ok: true, value: parsed.data }
}

/** Enumerate selectable binding targets: each node id with its input keys, deterministically sorted. */
export function graphTargets(graph: WorkflowGraph): { node: string; inputs: string[] }[] {
  return Object.keys(graph)
    .sort()
    .map((node) => ({ node, inputs: Object.keys(graph[node].inputs).sort() }))
}
```

- [ ] **Step 4: Re-export from the barrel**

Modify `packages/schema/src/index.ts` — add:
```ts
export * from './graph.js'
```

- [ ] **Step 5: Write the client-safety guard test (covers both hoisted leaves)**

`packages/schema/test/client-safe.test.ts`:
```ts
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src')

// These leaf modules are imported by client components (Next browser bundle). They must
// stay pure: no node:crypto (would break the bundle), no re-entry into the server-only
// barrel/keys/schema, and no @metamodels/connectors (a runtime value there pulls node:crypto,
// and it would also be a package cycle). This makes the boundary structural, not comment-only.
const FORBIDDEN = [
  /from ['"]node:crypto['"]/,
  /from ['"]\.\/keys(\.js)?['"]/,
  /from ['"]\.\/index(\.js)?['"]/,
  /from ['"]\.\/schema(\.js)?['"]/,
  /from ['"]@metamodels\/connectors['"]/,
]

describe.each(['config.ts', 'graph.ts'])('%s is client-safe', (file) => {
  test('imports no forbidden module', () => {
    const src = readFileSync(resolve(srcDir, file), 'utf8')
    for (const pattern of FORBIDDEN) {
      expect(pattern.test(src), `${file} must not match ${pattern}`).toBe(false)
    }
  })
})
```

- [ ] **Step 6: Run graph + guard tests to verify they pass**

Run: `pnpm --filter @metamodels/schema exec vitest run test/graph.test.ts test/client-safe.test.ts`
Expected: PASS — 4 graph tests + both client-safe cases (`config.ts` AND `graph.ts`) green.

- [ ] **Step 7: Re-point `template-schema.ts` at the hoisted graph schema**

Modify `apps/control-plane/src/lib/template-schema.ts` — replace the local `graphSchema` declaration with a re-export, keeping `paramSpecSchema`/`templateDraftSchema` (they reference the connector `ParamSpec` type, which the control-plane may depend on):
```ts
import { z } from 'zod'
import type { ParamSpec } from '@metamodels/connectors'

// graphSchema now lives in @metamodels/schema/graph (client-safe, shared). Re-exported so
// existing importers keep their path.
export { graphSchema } from '@metamodels/schema/graph'

const targetSchema = z.object({ node: z.string().min(1), input: z.string().min(1) })

/** The operator's declared params. Identical in shape to the connector's ParamSpec union. */
export const paramSpecSchema: z.ZodType<ParamSpec> = z.discriminatedUnion('type', [
  z.object({ name: z.string().min(1), type: z.literal('text'), target: targetSchema }),
  z.object({ name: z.string().min(1), type: z.literal('seed'), targets: z.array(targetSchema).min(1) }),
  z.object({
    name: z.string().min(1), type: z.literal('number'), target: targetSchema,
    min: z.number().optional(), max: z.number().optional(),
  }),
  z.object({ name: z.string().min(1), type: z.literal('image'), target: targetSchema }),
]) as z.ZodType<ParamSpec>

/** The editor's working draft: the graph as pasted text plus the declared params and cost. */
export const templateDraftSchema = z.object({
  id: z.string().min(1),
  graphText: z.string(),
  params: z.array(paramSpecSchema),
  cost: z.number().nonnegative(),
})
export type TemplateDraft = z.infer<typeof templateDraftSchema>
```

- [ ] **Step 8: Re-point `template-builder.ts` at the hoisted parse helpers**

In `apps/control-plane/src/lib/template-builder.ts`, find the line that re-exports the parse helpers from `./graph-parse` (it reads `export { parseGraphText, graphTargets } from './graph-parse'` and `export type { BuildResult } from './graph-parse'`, possibly combined) and any internal import of `parseGraphText` from `./graph-parse`. Replace every `'./graph-parse'` specifier with `'@metamodels/schema/graph'`. The re-export line becomes:
```ts
export { parseGraphText, graphTargets } from '@metamodels/schema/graph'
export type { BuildResult } from '@metamodels/schema/graph'
```
If `template-builder.ts` internally imports `parseGraphText` for `buildTemplate`, change that import line likewise to `from '@metamodels/schema/graph'`. Do NOT change anything that imports the runtime connector (`reconstructGraph`, `comfyuiConstraint`) — those stay server-only in this file.

- [ ] **Step 9: Re-point the editor client at the subpath**

In `apps/control-plane/src/app/(app)/paddocks/[id]/templates/templates-client.tsx`, change the import of `parseGraphText`/`graphTargets` (and `BuildResult` if imported) — currently from `'../../../../../lib/graph-parse'` or via `template-builder` — to:
```ts
import { parseGraphText, graphTargets } from '@metamodels/schema/graph'
```
(Adjust to include `type { BuildResult }` in the same statement only if the client references that type.)

- [ ] **Step 10: Delete the superseded leaf**

```bash
git rm apps/control-plane/src/lib/graph-parse.ts
```
Then search for stragglers:

Run: `grep -rn "lib/graph-parse\|'\./graph-parse'" apps/control-plane/src`
Expected: no matches. (If any remain, re-point them to `@metamodels/schema/graph` before proceeding.)

- [ ] **Step 11: Verify typecheck, both suites, and the client build**

Run: `pnpm -w exec tsc -b`
Expected: clean.

Run: `pnpm test`
Expected: 176 pass / 3 skip (170 after Task 1 + 4 graph tests + 2 client-safe cases).

Run: `pnpm --filter @metamodels/control-plane exec vitest run`
Expected: 85 pass (Plan 5.3's template-schema/template-builder tests still green via the re-exports).

Run: `pnpm --filter @metamodels/control-plane exec next build --webpack`
Expected: build succeeds; the route list includes `/paddocks/[id]/templates`. This is the real proof the client bundle no longer pulls `node:crypto` through the graph helpers.

- [ ] **Step 12: Commit**

```bash
git add packages/schema apps/control-plane/src/lib/template-schema.ts apps/control-plane/src/lib/template-builder.ts apps/control-plane/src/app/\(app\)/paddocks/\[id\]/templates/templates-client.tsx
git commit -m "refactor(schema): hoist graphSchema + graph-parse to client-safe @metamodels/schema/graph"
```

---

### Task 3: keys-service — listKeys + createKey (org-consistent, shown-once)

**Files:**
- Create: `apps/control-plane/src/lib/key-schema.ts`
- Create: `apps/control-plane/src/server/keys-service.ts`
- Create: `apps/control-plane/src/server/keys-service.test.ts`

**Interfaces:**
- Consumes: `generateApiKey` from `@metamodels/schema`; `rateLimitSchema` from `@metamodels/schema/config`; `apiKey`/`keyPaddock`/`paddock` tables + `Actor`/`requireCapability`/`writeAudit`/`NotFoundError` (from `./flocks-service`) following the established CRUD template; `Db` from `./db`.
- Produces:
  - `key-schema.ts`: `createKeyInput` (Zod) + `type CreateKeyInput`.
  - `keys-service.ts`:
    - `interface KeyRow { id: string; name: string; prefix: string; status: string; expiresAt: Date | null; createdAt: Date; paddockSlugs: string[] }`
    - `interface CreatedKey { id: string; name: string; prefix: string; plaintext: string }`
    - `listKeys(db, actor): Promise<KeyRow[]>`
    - `createKey(db, actor, input: unknown): Promise<CreatedKey>` — the ONLY place `plaintext` is ever returned.

- [ ] **Step 1: Write the failing service test**

`apps/control-plane/src/server/keys-service.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '@metamodels/schema'
import { freshDb, seedOrg, type TestDb } from '../test/db'
import { listKeys, createKey } from './keys-service'
import { ForbiddenError, NotFoundError, type Actor } from '../auth/authorize'

async function actorFor(db: TestDb, role: Actor['role']): Promise<Actor> {
  const o = await seedOrg(db)
  return { id: 'u1', orgId: o.id, email: `${role}@x.io`, role }
}

async function paddockIn(db: TestDb, orgId: string, slug: string): Promise<string> {
  const [f] = await db.insert(schema.flock).values({
    orgId, breed: 'ollama', name: 'f', baseUrl: 'http://f',
  }).returning()
  const [p] = await db.insert(schema.paddock).values({
    orgId, flockId: f.id, slug, name: slug,
  }).returning()
  return p.id
}

describe('keys-service createKey', () => {
  test('mints an mm_live_ key; plaintext returned once, only hash+prefix stored', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'member')
    const pid = await paddockIn(db, actor.orgId, 'p1')

    const created = await createKey(db, actor, { name: 'ci', paddockIds: [pid] })
    expect(created.plaintext.startsWith('mm_live_')).toBe(true)
    expect(created.prefix).toBe(created.plaintext.slice(0, 12))

    const [row] = await db.select().from(schema.apiKey).where(eq(schema.apiKey.id, created.id))
    expect(row.orgId).toBe(actor.orgId)
    expect(row.name).toBe('ci')
    expect(row.status).toBe('active')
    expect(row.prefix).toBe(created.prefix)
    // plaintext is NEVER persisted
    expect(row.hash).not.toBe(created.plaintext)
    expect(JSON.stringify(row)).not.toContain(created.plaintext)

    // scope link created
    const links = await db.select().from(schema.keyPaddock).where(eq(schema.keyPaddock.keyId, created.id))
    expect(links.map((l) => l.paddockId)).toEqual([pid])

    // audited without leaking the secret
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'key.create'))
    expect(audits).toHaveLength(1)
    expect(JSON.stringify(audits[0])).not.toContain(created.plaintext)
  })

  test('org consistency: linking a paddock in another org is rejected; nothing is written', async () => {
    const db = await freshDb()
    const mine = await actorFor(db, 'admin')
    const [otherOrg] = await db.insert(schema.org).values({ name: 'other' }).returning()
    const foreignPid = await paddockIn(db, otherOrg.id, 'foreign')

    await expect(createKey(db, mine, { name: 'x', paddockIds: [foreignPid] }))
      .rejects.toThrow(NotFoundError)
    expect(await db.select().from(schema.apiKey)).toHaveLength(0)
    expect(await db.select().from(schema.keyPaddock)).toHaveLength(0)
    expect(await db.select().from(schema.auditLog)).toHaveLength(0)
  })

  test('duplicate paddockIds are de-duplicated into one scope link', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    const pid = await paddockIn(db, actor.orgId, 'p1')
    const created = await createKey(db, actor, { name: 'dup', paddockIds: [pid, pid] })
    const links = await db.select().from(schema.keyPaddock).where(eq(schema.keyPaddock.keyId, created.id))
    expect(links).toHaveLength(1)
  })

  test('optional per-key rate override is validated and persisted', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    const pid = await paddockIn(db, actor.orgId, 'p1')
    const created = await createKey(db, actor, {
      name: 'o', paddockIds: [pid], overrides: { rateLimit: { windowSec: 60, max: 10 } },
    })
    const [row] = await db.select().from(schema.apiKey).where(eq(schema.apiKey.id, created.id))
    expect(row.overrides).toEqual({ rateLimit: { windowSec: 60, max: 10 } })

    await expect(createKey(db, actor, {
      name: 'bad', paddockIds: [pid], overrides: { rateLimit: { windowSec: 0, max: 10 } },
    })).rejects.toThrow()
  })

  test('viewer cannot create a key; nothing is written', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'viewer')
    const pid = await paddockIn(db, actor.orgId, 'p1')
    await expect(createKey(db, actor, { name: 'x', paddockIds: [pid] })).rejects.toThrow(ForbiddenError)
    expect(await db.select().from(schema.apiKey)).toHaveLength(0)
  })

  test('listKeys returns only this org, with prefix/status/paddock slugs, no hash', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    const pid = await paddockIn(db, actor.orgId, 'p1')
    await createKey(db, actor, { name: 'a', paddockIds: [pid] })

    // a key in another org must not appear
    const [otherOrg] = await db.insert(schema.org).values({ name: 'other' }).returning()
    await db.insert(schema.apiKey).values({
      orgId: otherOrg.id, name: 'foreign', prefix: 'mm_live_zzzz', hash: 'deadbeef', status: 'active',
    })

    const rows = await listKeys(db, actor)
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('a')
    expect(rows[0].paddockSlugs).toEqual(['p1'])
    expect(rows[0]).not.toHaveProperty('hash')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/keys-service.test.ts`
Expected: FAIL — `Cannot find module './keys-service'` (and `./key-schema`).

- [ ] **Step 3: Create the input schema**

`apps/control-plane/src/lib/key-schema.ts`:
```ts
import { z } from 'zod'
import { rateLimitSchema } from '@metamodels/schema/config'

/** Optional per-key overrides. Mirrors the data-plane `KeyOverrides` shape ({ rateLimit? }). */
export const keyOverridesSchema = z.object({
  rateLimit: rateLimitSchema,
}).partial()

export const createKeyInput = z.object({
  name: z.string().min(1).max(120),
  // At least one org-owned paddock. Org consistency is enforced in the service, not here.
  paddockIds: z.array(z.string().uuid()).min(1),
  expiresAt: z.string().datetime().optional(),
  overrides: keyOverridesSchema.optional(),
})
export type CreateKeyInput = z.infer<typeof createKeyInput>
```

- [ ] **Step 4: Create the service**

`apps/control-plane/src/server/keys-service.ts`:
```ts
import { and, eq, inArray } from 'drizzle-orm'
import { apiKey, generateApiKey, keyPaddock, paddock } from '@metamodels/schema'
import type { Db } from './db'
import { requireCapability, type Actor } from '../auth/authorize'
import { writeAudit } from './audit'
import { NotFoundError } from './flocks-service'
import { createKeyInput } from '../lib/key-schema'

export { NotFoundError }

export interface KeyRow {
  id: string
  name: string
  prefix: string
  status: string
  expiresAt: Date | null
  createdAt: Date
  paddockSlugs: string[]
}

export interface CreatedKey {
  id: string
  name: string
  prefix: string
  /** The full secret — surfaced exactly once here; never stored, logged, or listed. */
  plaintext: string
}

export async function listKeys(db: Db, actor: Actor): Promise<KeyRow[]> {
  requireCapability(actor, 'read')
  const keys = await db
    .select({
      id: apiKey.id, name: apiKey.name, prefix: apiKey.prefix,
      status: apiKey.status, expiresAt: apiKey.expiresAt, createdAt: apiKey.createdAt,
    })
    .from(apiKey)
    .where(eq(apiKey.orgId, actor.orgId))
  if (keys.length === 0) return []

  // Scope slugs per key, org-scoped on the paddock join (defense in depth).
  const links = await db
    .select({ keyId: keyPaddock.keyId, slug: paddock.slug })
    .from(keyPaddock)
    .innerJoin(paddock, eq(keyPaddock.paddockId, paddock.id))
    .where(and(inArray(keyPaddock.keyId, keys.map((k) => k.id)), eq(paddock.orgId, actor.orgId)))
  const bySlug = new Map<string, string[]>()
  for (const l of links) {
    const arr = bySlug.get(l.keyId) ?? []
    arr.push(l.slug)
    bySlug.set(l.keyId, arr)
  }

  return keys.map((k) => ({
    ...k,
    paddockSlugs: (bySlug.get(k.id) ?? []).sort(),
  }))
}

export async function createKey(db: Db, actor: Actor, input: unknown): Promise<CreatedKey> {
  requireCapability(actor, 'resource.write')
  const data = createKeyInput.parse(input)
  const ids = [...new Set(data.paddockIds)]
  const secret = generateApiKey()

  return db.transaction(async (tx) => {
    // Org consistency: every scoped paddock must belong to the actor's org.
    const owned = await tx
      .select({ id: paddock.id })
      .from(paddock)
      .where(and(eq(paddock.orgId, actor.orgId), inArray(paddock.id, ids)))
    if (owned.length !== ids.length) throw new NotFoundError('paddock (cross-org or missing)')

    const [created] = await tx
      .insert(apiKey)
      .values({
        orgId: actor.orgId,
        name: data.name,
        prefix: secret.prefix,
        hash: secret.hash,
        status: 'active',
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
        overrides: (data.overrides ?? null) as never,
      })
      .returning()

    await tx.insert(keyPaddock).values(ids.map((pid) => ({ keyId: created.id, paddockId: pid })))

    await writeAudit(tx, {
      orgId: actor.orgId, actor: actor.email, action: 'key.create',
      target: `key:${created.id}`, detail: { name: created.name, paddocks: ids.length },
    })

    return { id: created.id, name: created.name, prefix: created.prefix, plaintext: secret.plaintext }
  })
}
```

- [ ] **Step 5: Run the service test to verify it passes**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/keys-service.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Verify typecheck + both suites**

Run: `pnpm -w exec tsc -b`
Expected: clean.

Run: `pnpm --filter @metamodels/control-plane exec vitest run`
Expected: 91 pass (85 + 6).

- [ ] **Step 7: Commit**

```bash
git add apps/control-plane/src/lib/key-schema.ts apps/control-plane/src/server/keys-service.ts apps/control-plane/src/server/keys-service.test.ts
git commit -m "feat(control-plane): keys-service createKey/listKeys — org-consistent, shown-once secret"
```

---

### Task 4: keys-service — revokeKey

**Files:**
- Modify: `apps/control-plane/src/server/keys-service.ts` (add `revokeKey`)
- Modify: `apps/control-plane/src/server/keys-service.test.ts` (add revoke tests)

**Interfaces:**
- Consumes: same as Task 3.
- Produces: `revokeKey(db, actor, id: string): Promise<void>` — org-scoped status flip to `'revoked'`, audited `key.revoke`, `NotFoundError` on a missing/cross-org id.

- [ ] **Step 1: Add the failing revoke tests**

Append inside the top-level of `apps/control-plane/src/server/keys-service.test.ts` (add `revokeKey` to the import from `./keys-service`, then add this `describe` block):
```ts
describe('keys-service revokeKey', () => {
  test('flips status to revoked and audits it', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    const pid = await paddockIn(db, actor.orgId, 'p1')
    const created = await createKey(db, actor, { name: 'k', paddockIds: [pid] })

    await revokeKey(db, actor, created.id)

    const [row] = await db.select().from(schema.apiKey).where(eq(schema.apiKey.id, created.id))
    expect(row.status).toBe('revoked')
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'key.revoke'))
    expect(audits).toHaveLength(1)
    expect(audits[0].target).toBe(`key:${created.id}`)
  })

  test('cannot revoke a key in another org', async () => {
    const db = await freshDb()
    const mine = await actorFor(db, 'admin')
    const [otherOrg] = await db.insert(schema.org).values({ name: 'other' }).returning()
    const [foreign] = await db.insert(schema.apiKey).values({
      orgId: otherOrg.id, name: 'foreign', prefix: 'mm_live_zzzz', hash: 'dead', status: 'active',
    }).returning()

    await expect(revokeKey(db, mine, foreign.id)).rejects.toThrow(NotFoundError)
    const [still] = await db.select().from(schema.apiKey).where(eq(schema.apiKey.id, foreign.id))
    expect(still.status).toBe('active')
  })

  test('viewer cannot revoke', async () => {
    const db = await freshDb()
    const admin = await actorFor(db, 'admin')
    const pid = await paddockIn(db, admin.orgId, 'p1')
    const created = await createKey(db, admin, { name: 'k', paddockIds: [pid] })
    const viewer: Actor = { ...admin, role: 'viewer', email: 'viewer@x.io' }
    await expect(revokeKey(db, viewer, created.id)).rejects.toThrow(ForbiddenError)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/keys-service.test.ts`
Expected: FAIL — `revokeKey` is not exported.

- [ ] **Step 3: Implement `revokeKey`**

Append to `apps/control-plane/src/server/keys-service.ts`:
```ts
export async function revokeKey(db: Db, actor: Actor, id: string): Promise<void> {
  requireCapability(actor, 'resource.write')
  await db.transaction(async (tx) => {
    const [revoked] = await tx
      .update(apiKey)
      .set({ status: 'revoked' })
      .where(and(eq(apiKey.id, id), eq(apiKey.orgId, actor.orgId)))
      .returning()
    if (!revoked) throw new NotFoundError(`key ${id}`)
    await writeAudit(tx, {
      orgId: actor.orgId, actor: actor.email, action: 'key.revoke', target: `key:${id}`,
    })
  })
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/keys-service.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Verify typecheck + suite**

Run: `pnpm -w exec tsc -b`
Expected: clean.

Run: `pnpm --filter @metamodels/control-plane exec vitest run`
Expected: 94 pass (91 + 3).

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane/src/server/keys-service.ts apps/control-plane/src/server/keys-service.test.ts
git commit -m "feat(control-plane): keys-service revokeKey — org-scoped status flip + audit"
```

---

### Task 5: Screen 9d — the API Keys route (`/keys`)

**Files:**
- Create: `apps/control-plane/src/app/(app)/keys/page.tsx`
- Create: `apps/control-plane/src/app/(app)/keys/actions.ts`
- Create: `apps/control-plane/src/app/(app)/keys/keys-client.tsx`
- Modify: `apps/control-plane/README.md` (document the screen)

**Interfaces:**
- Consumes: `listKeys`/`createKey`/`revokeKey` (service), `requireUser`/`getDb`, `authorize`/`requireCapability`, `listPaddocks` (for the scope multi-select), the shared UI components (`PageHeader`, `DataTable`, `Button`, `Input`, `Label`, `Drawer`, `StatusPill`). The `/keys` nav item already exists in `auth/nav.ts`.
- Produces: screen 9d. The mint form posts to `createKeyAction`, which returns `{ plaintext, prefix }` once for a shown-once reveal; the client NEVER re-requests or persists the plaintext.

- [ ] **Step 1: Create the server actions**

`apps/control-plane/src/app/(app)/keys/actions.ts`:
```ts
'use server'
import { revalidatePath } from 'next/cache'
import { getDb } from '../../../server/db'
import { requireUser } from '../../../server/guard'
import { requireCapability } from '../../../auth/authorize'
import { createKey, revokeKey } from '../../../server/keys-service'

export async function createKeyAction(
  _prev: unknown, fd: FormData,
): Promise<{ error?: string; plaintext?: string; prefix?: string }> {
  const actor = await requireUser()
  try {
    requireCapability(actor, 'resource.write')
    const paddockIds = fd.getAll('paddockIds').map(String).filter(Boolean)
    const expiresAt = String(fd.get('expiresAt') ?? '').trim()
    const rlMax = String(fd.get('rateMax') ?? '').trim()
    const rlWindow = String(fd.get('rateWindowSec') ?? '').trim()
    const overrides = rlMax && rlWindow
      ? { rateLimit: { windowSec: Number(rlWindow), max: Number(rlMax) } }
      : undefined
    const created = await createKey(getDb(), actor, {
      name: String(fd.get('name') ?? '').trim(),
      paddockIds,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
      overrides,
    })
    revalidatePath('/keys')
    return { plaintext: created.plaintext, prefix: created.prefix }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed to create key' }
  }
}

export async function revokeKeyAction(fd: FormData): Promise<void> {
  const actor = await requireUser()
  requireCapability(actor, 'resource.write')
  await revokeKey(getDb(), actor, String(fd.get('id')))
  revalidatePath('/keys')
}
```

- [ ] **Step 2: Create the server page**

`apps/control-plane/src/app/(app)/keys/page.tsx`:
```tsx
import { getDb } from '../../../server/db'
import { requireUser } from '../../../server/guard'
import { authorize } from '../../../auth/authorize'
import { listKeys } from '../../../server/keys-service'
import { listPaddocks } from '../../../server/paddocks-service'
import { KeysClient } from './keys-client'

export default async function KeysPage() {
  const actor = await requireUser()
  const db = getDb()
  const [keys, paddocks] = await Promise.all([listKeys(db, actor), listPaddocks(db, actor)])
  const canWrite = authorize(actor, 'resource.write')
  return (
    <KeysClient
      canWrite={canWrite}
      paddocks={paddocks.map((p) => ({ id: p.id, name: p.name, slug: p.slug }))}
      keys={keys.map((k) => ({
        id: k.id, name: k.name, prefix: k.prefix, status: k.status,
        expiresAt: k.expiresAt ? k.expiresAt.toISOString() : null,
        paddockSlugs: k.paddockSlugs,
      }))}
    />
  )
}
```

- [ ] **Step 3: Create the client**

`apps/control-plane/src/app/(app)/keys/keys-client.tsx`:
```tsx
'use client'
import { useState } from 'react'
import { PageHeader } from '../../../components/page-header'
import { DataTable } from '../../../components/ui/data-table'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { Label } from '../../../components/ui/label'
import { Drawer } from '../../../components/ui/drawer'
import { StatusPill } from '../../../components/ui/status-pill'
import { createKeyAction, revokeKeyAction } from './actions'

interface PaddockOpt { id: string; name: string; slug: string }
interface KeyRow {
  id: string; name: string; prefix: string; status: string
  expiresAt: string | null; paddockSlugs: string[]
}

export function KeysClient(
  { keys, paddocks, canWrite }: { keys: KeyRow[]; paddocks: PaddockOpt[]; canWrite: boolean },
) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [secret, setSecret] = useState<{ plaintext: string; prefix: string } | null>(null)

  async function onCreate(fd: FormData) {
    const r = await createKeyAction(null, fd)
    if (r.error) { setError(r.error); return }
    setError(undefined)
    setOpen(false)
    if (r.plaintext && r.prefix) setSecret({ plaintext: r.plaintext, prefix: r.prefix })
  }

  return (
    <div>
      <PageHeader
        title="API Keys"
        subtitle="Mint keys scoped to paddocks. A key's secret is shown once, at creation."
        actions={canWrite && <Button onClick={() => { setError(undefined); setOpen(true) }}>Mint a key</Button>}
      />

      {secret && (
        <div className="mb-4 rounded-[var(--radius-control)] border border-[var(--color-primary)] bg-[var(--color-panel-2)] p-4">
          <div className="mb-1 text-sm font-semibold text-[var(--color-primary)]">
            Copy this key now — it will not be shown again.
          </div>
          <code className="block break-all font-mono text-sm text-[var(--color-text)]">{secret.plaintext}</code>
          <div className="mt-2">
            <Button variant="ghost" onClick={() => setSecret(null)}>Done</Button>
          </div>
        </div>
      )}

      <DataTable headers={['Name', 'Prefix', 'Paddocks', 'Status', 'Expires', '']}>
        {keys.map((k) => (
          <tr key={k.id} className="border-b border-[var(--color-divider)]">
            <td className="px-3 py-2 text-[var(--color-text)]">{k.name}</td>
            <td className="px-3 py-2 font-mono text-xs text-[var(--color-muted)]">{k.prefix}…</td>
            <td className="px-3 py-2 text-xs text-[var(--color-muted)]">{k.paddockSlugs.join(', ') || '—'}</td>
            <td className="px-3 py-2"><StatusPill ok={k.status === 'active'} /></td>
            <td className="px-3 py-2 text-xs text-[var(--color-muted)]">{k.expiresAt ? k.expiresAt.slice(0, 10) : '—'}</td>
            <td className="px-3 py-2 text-right">
              {canWrite && k.status === 'active' && (
                <form action={revokeKeyAction} className="inline">
                  <input type="hidden" name="id" value={k.id} />
                  <Button variant="danger" type="submit">Revoke</Button>
                </form>
              )}
            </td>
          </tr>
        ))}
        {keys.length === 0 && (
          <tr><td colSpan={6} className="px-3 py-8 text-center text-[var(--color-muted)]">No keys yet. Mint one to give a consumer access.</td></tr>
        )}
      </DataTable>

      <Drawer open={open} onClose={() => setOpen(false)} title="Mint a key">
        <form action={onCreate} className="flex flex-col gap-4">
          <div><Label htmlFor="name">Name</Label><Input id="name" name="name" required /></div>

          <div>
            <Label htmlFor="paddockIds">Scope to paddocks</Label>
            {paddocks.length === 0 ? (
              <div className="text-sm text-[var(--color-muted)]">No paddocks yet — publish one first.</div>
            ) : (
              <select
                id="paddockIds" name="paddockIds" multiple required
                className="w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-panel)] p-2 text-sm"
              >
                {paddocks.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.slug})</option>)}
              </select>
            )}
          </div>

          <div><Label htmlFor="expiresAt">Expires (optional)</Label><Input id="expiresAt" name="expiresAt" type="date" /></div>

          <fieldset className="rounded-[var(--radius-control)] border border-[var(--color-border)] p-3">
            <legend className="px-1 text-xs text-[var(--color-muted)]">Per-key rate override (optional)</legend>
            <div className="flex gap-2">
              <div className="flex-1"><Label htmlFor="rateMax">Max requests</Label><Input id="rateMax" name="rateMax" type="number" min="0" /></div>
              <div className="flex-1"><Label htmlFor="rateWindowSec">Per (seconds)</Label><Input id="rateWindowSec" name="rateWindowSec" type="number" min="1" /></div>
            </div>
          </fieldset>

          {error && <div className="text-sm text-[var(--color-danger)]">{error}</div>}
          <div className="flex gap-2">
            <Button type="submit" disabled={paddocks.length === 0}>Create key</Button>
          </div>
        </form>
      </Drawer>
    </div>
  )
}
```

- [ ] **Step 4: Document the screen**

In `apps/control-plane/README.md`, add a line to the Screens list (mirroring the existing entries, e.g. right after the Paddocks/Templates lines):
```markdown
- **API Keys** (`/keys`) — mint a paddock-scoped `mm_live_` key (secret shown once), set an optional expiry and per-key rate override, and revoke keys.
```

- [ ] **Step 5: Verify typecheck, build, and both suites**

Run: `pnpm -w exec tsc -b`
Expected: clean.

Run: `pnpm --filter @metamodels/control-plane exec next build --webpack`
Expected: build succeeds; route list includes `/keys`.

Run: `pnpm --filter @metamodels/control-plane exec vitest run`
Expected: 94 pass (screen is UI — no new unit tests; behavior is covered by the service tests).

Run: `pnpm test`
Expected: root suite green (176 pass / 3 skip, unchanged from Task 2).

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane/src/app/\(app\)/keys apps/control-plane/README.md
git commit -m "feat(control-plane): screen 9d — API Keys (mint shown-once, scope, override, revoke)"
```

---

## Self-Review

**Spec coverage:**
- Schema hoist — rate/quota (Plan 5.2 carry-forward Minor) → Task 1; graphSchema + graph-parse (Plan 5.3 whole-branch advisory) → Task 2. Both land in genuinely client-safe subpaths with a structural guard test. ✓
- Key↔paddock org consistency (the headline 5.4 security property) → Task 3 (`createKey` org-scoped join, cross-org rejected, nothing written). ✓
- API key format `mm_live_`, hashed SHA-256, shown-once plaintext → Task 3 (`generateApiKey`, plaintext returned once) + Task 5 (shown-once reveal). ✓
- Mint / scope / optional expiry / optional per-key rate override / revoke → Tasks 3–5. ✓
- Capability gate + tx + audit on every write → Tasks 3–4 (established CRUD template). ✓
- No new migration, no new dependency → tables + key helpers pre-exist. ✓

**Placeholder scan:** every code step carries complete code; every run step has an exact command + expected output. No TBD/TODO. ✓

**Type consistency:** `createKeyInput`/`CreateKeyInput`, `KeyRow`, `CreatedKey`, `WorkflowGraph`, `BuildResult<T>`, `parseGraphText`/`graphTargets`, `rateLimitSchema`/`quotaRuleSchema`/`quotaSchema`, `RateLimitInput`/`QuotaRule` used consistently across tasks. `revokeKey`/`createKey`/`listKeys` signatures match between service, tests, and actions. The `keyOverridesSchema` shape (`{ rateLimit? }`) matches the data-plane `KeyOverrides` interface. ✓

**Deferred (carried forward, out of scope here):** the `UNIQUE(key_id, paddock_id)` index (spec "consider" — dedup is handled app-side via `new Set`; add the index when multi-user lands in 5.7); the Plan 5.3 seed-target-overlap guard and concurrent-save lock; the `.positive()`-on-`max` cosmetic. None block this plan.
