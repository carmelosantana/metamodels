# Plan 5.3 — ComfyUI paramSchema Editor (screen 8b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator author ComfyUI workflow templates for a Paddock — paste a workflow-API graph, bind typed params (text/seed/number/image) to node inputs, set a cost, and prove the template round-trips through `reconstructGraph` before it is saved into the Fence's `constraint_json.templates`.

**Architecture:** Screen 8b is a structured editor over the ComfyUI Fence's `constraint_json.templates: WorkflowTemplate[]` — the *same* array the data-plane's `reconstructGraph` consumes at request time. Pure, Next-free modules (`template-schema.ts`, `template-builder.ts`) do the parse/bind/build/dry-run and are unit-tested with vitest; a `templates-service.ts` persists templates through the org-scoped transaction+audit CRUD template, writing **only** the `constraint_json` column so it never clobbers the Fence's rate-limit/quota. A dedicated `/paddocks/[id]/templates` route (RSC page + thin Server Actions + one client editor) is the UI. Task 5 removes the Plan 5.2 hidden-field templates round-trip from the 9c fence editor so templates are managed server-side only.

**Tech Stack:** TypeScript ESM, Next.js 16.2.0 (App Router, `--webpack`), Drizzle + pglite (tests), Zod, `@metamodels/connectors` (`reconstructGraph`, `comfyuiConstraint`, `ParamSpec`, `WorkflowTemplate`), vitest.

## Global Constraints

- **Security invariants of `reconstructGraph` are law — the editor must only ever produce specs that keep them true:** a consumer key not matching a declared `ParamSpec.name` is rejected (unknown-param → 4xx); `seed` params are **server-generated per run and are never a consumer input field**; `image` params resolve from a trusted upload slot keyed by param name, never from consumer-supplied bytes-as-value.
- **Templates persist inside `fence.constraint_json` (existing `jsonb`). No schema change, no new migration.** The stored array must validate against the breed's own `comfyuiConstraint` (`{ templates: WorkflowTemplate[] }`) — the exact schema the data-plane re-parses.
- **Copy the Plan 5.1 CRUD template verbatim:** `requireCapability(actor, cap)` → Zod parse → org-scope join → **mutation + `writeAudit(tx, …)` in one `db.transaction`**, `NotFoundError` thrown *inside* the tx on empty `.returning()`. Capability + Zod run BEFORE the tx.
- **Org isolation:** every template write goes through `paddockBreedInOrg(tx, actor, paddockId)` (the single org choke point in `fences-service.ts`), and must reject any paddock whose breed is not `comfyui`.
- **`authorize`/`requireCapability` is the server boundary; UI hiding (`canWrite`) is convenience only.** Every write Server Action re-checks `requireCapability(actor, 'resource.write')` server-side and fails closed.
- **Pin/verify, do not restructure:** no new runtime dependencies. Reuse `reconstructGraph`, `comfyuiConstraint`, `ParamSpec`, `WorkflowTemplate` from `@metamodels/connectors` — never re-declare the graph/param shapes locally.
- **Two test lanes:** control-plane logic runs under `pnpm --filter @metamodels/control-plane exec vitest run`; root suite is `pnpm test`. Both must stay green. Typecheck the whole workspace with `pnpm -w exec tsc -b`.

---

## File structure

**Create:**
- `apps/control-plane/src/lib/template-schema.ts` — Zod for the operator's editor draft: `graphSchema`, `templateDraftSchema` (id, graphText, params: `ParamSpec[]`, cost). Types re-exported.
- `apps/control-plane/src/lib/template-schema.test.ts`
- `apps/control-plane/src/lib/template-builder.ts` — pure functions: `parseGraphText`, `graphTargets`, `buildTemplate`, `dryRunTemplate`, `validateDraft`. The security-critical assembly + `reconstructGraph` proof.
- `apps/control-plane/src/lib/template-builder.test.ts`
- `apps/control-plane/src/server/templates-service.ts` — `saveTemplate`, `deleteTemplate` (org-scoped, comfyui-only, tx+audit, constraint-only writes).
- `apps/control-plane/src/server/templates-service.test.ts`
- `apps/control-plane/src/app/(app)/paddocks/[id]/templates/page.tsx` — RSC shell.
- `apps/control-plane/src/app/(app)/paddocks/[id]/templates/actions.ts` — `saveTemplateAction`, `deleteTemplateAction`, `dryRunTemplateAction`.
- `apps/control-plane/src/app/(app)/paddocks/[id]/templates/templates-client.tsx` — the editor UI.

**Modify:**
- `apps/control-plane/src/server/fences-service.ts` — export `paddockBreedInOrg`; make `saveFence` preserve `constraint_json` when the caller omits it (kills the 9c round-trip + clobber).
- `apps/control-plane/src/lib/fence-schema.ts` — `saveFenceInput.constraintJson` becomes explicitly optional (doc the preserve-on-omit contract).
- `apps/control-plane/src/app/(app)/paddocks/[id]/fence/actions.ts` — comfyui branch no longer parses/sends `constraintJson`.
- `apps/control-plane/src/app/(app)/paddocks/[id]/fence/fence-client.tsx` — remove the hidden `constraintJson` field; replace the "coming in Plan 5.3" note with a "Manage templates →" link.
- `apps/control-plane/src/app/(app)/paddocks/[id]/paddocks-client.tsx` *(or the paddocks row actions)* — add a "Templates" link for comfyui paddocks (Task 8).
- `apps/control-plane/README.md` — document the Templates screen (Task 8).

---

## Task 1: Draft schema (`template-schema.ts`)

**Files:**
- Create: `apps/control-plane/src/lib/template-schema.ts`
- Test: `apps/control-plane/src/lib/template-schema.test.ts`

**Interfaces:**
- Consumes: `ParamSpec`, `WorkflowTemplate` from `@metamodels/connectors`; `z` from `zod`.
- Produces:
  - `graphSchema: z.ZodType<WorkflowTemplate['graph']>` — `Record<string, { class_type: string; inputs: Record<string, unknown> }>`.
  - `paramSpecSchema: z.ZodType<ParamSpec>` — discriminated union mirroring the connector's ParamSpec.
  - `templateDraftSchema` → `TemplateDraft = { id: string; graphText: string; params: ParamSpec[]; cost: number }`.
  - `export type TemplateDraft = z.infer<typeof templateDraftSchema>`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/control-plane/src/lib/template-schema.test.ts
import { describe, expect, test } from 'vitest'
import { graphSchema, templateDraftSchema } from './template-schema'

describe('graphSchema', () => {
  test('accepts a well-formed workflow-api graph', () => {
    const g = { '3': { class_type: 'KSampler', inputs: { seed: 0, steps: 20 } } }
    expect(graphSchema.parse(g)).toEqual(g)
  })
  test('rejects a node missing class_type', () => {
    expect(() => graphSchema.parse({ '3': { inputs: {} } })).toThrow()
  })
  test('rejects a node whose inputs is not an object', () => {
    expect(() => graphSchema.parse({ '3': { class_type: 'X', inputs: 5 } })).toThrow()
  })
})

describe('templateDraftSchema', () => {
  const graphText = JSON.stringify({ '4': { class_type: 'CLIPTextEncode', inputs: { text: '' } } })
  test('accepts a minimal draft with one text param', () => {
    const d = templateDraftSchema.parse({
      id: 'txt2img', graphText,
      params: [{ name: 'prompt', type: 'text', target: { node: '4', input: 'text' } }],
      cost: 1,
    })
    expect(d.id).toBe('txt2img')
    expect(d.params[0].type).toBe('text')
  })
  test('rejects an empty id', () => {
    expect(() => templateDraftSchema.parse({ id: '', graphText, params: [], cost: 1 })).toThrow()
  })
  test('rejects a negative cost', () => {
    expect(() => templateDraftSchema.parse({ id: 'x', graphText, params: [], cost: -1 })).toThrow()
  })
  test('rejects a param with an unknown type', () => {
    expect(() => templateDraftSchema.parse({
      id: 'x', graphText, params: [{ name: 'p', type: 'bogus', target: { node: '4', input: 'text' } }], cost: 1,
    })).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/lib/template-schema.test.ts`
Expected: FAIL — cannot find module `./template-schema`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/control-plane/src/lib/template-schema.ts
import { z } from 'zod'
import type { ParamSpec, WorkflowTemplate } from '@metamodels/connectors'

const targetSchema = z.object({ node: z.string().min(1), input: z.string().min(1) })

/** Node graph in ComfyUI workflow-API form. Mirrors the connector's stored graph shape. */
export const graphSchema: z.ZodType<WorkflowTemplate['graph']> = z.record(
  z.object({ class_type: z.string().min(1), inputs: z.record(z.unknown()) }),
) as z.ZodType<WorkflowTemplate['graph']>

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

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/lib/template-schema.test.ts`
Expected: PASS (all 7).

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/lib/template-schema.ts apps/control-plane/src/lib/template-schema.test.ts
git commit -m "feat(control-plane): template draft schema (graph + ParamSpec + cost)"
```

---

## Task 2: Graph parsing + target enumeration (`template-builder.ts`)

**Files:**
- Create: `apps/control-plane/src/lib/template-builder.ts`
- Test: `apps/control-plane/src/lib/template-builder.test.ts`

**Interfaces:**
- Consumes: `graphSchema` from `./template-schema`; `WorkflowTemplate` from `@metamodels/connectors`.
- Produces:
  - `type BuildResult<T> = { ok: true; value: T } | { ok: false; reason: string }`.
  - `parseGraphText(text: string): BuildResult<WorkflowTemplate['graph']>` — `JSON.parse` guarded, then `graphSchema`.
  - `graphTargets(graph): { node: string; inputs: string[] }[]` — node ids + their input keys, sorted by node id, inputs sorted, for the binding dropdowns.

- [ ] **Step 1: Write the failing test**

```ts
// apps/control-plane/src/lib/template-builder.test.ts
import { describe, expect, test } from 'vitest'
import { parseGraphText, graphTargets } from './template-builder'

const GRAPH = {
  '4': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['1', 0] } },
  '3': { class_type: 'KSampler', inputs: { seed: 0, steps: 20 } },
}

describe('parseGraphText', () => {
  test('parses valid workflow-api json', () => {
    const r = parseGraphText(JSON.stringify(GRAPH))
    expect(r.ok).toBe(true)
    if (r.ok) expect(Object.keys(r.value)).toContain('4')
  })
  test('fails on non-json with a friendly reason', () => {
    const r = parseGraphText('{ not json')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason.toLowerCase()).toContain('json')
  })
  test('fails on json that is not a valid graph', () => {
    const r = parseGraphText(JSON.stringify({ '3': { inputs: {} } }))
    expect(r.ok).toBe(false)
  })
})

describe('graphTargets', () => {
  test('lists nodes (sorted) with their input keys (sorted)', () => {
    expect(graphTargets(GRAPH)).toEqual([
      { node: '3', inputs: ['seed', 'steps'] },
      { node: '4', inputs: ['clip', 'text'] },
    ])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/lib/template-builder.test.ts`
Expected: FAIL — cannot find module `./template-builder`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/control-plane/src/lib/template-builder.ts
import type { WorkflowTemplate } from '@metamodels/connectors'
import { graphSchema } from './template-schema'

export type BuildResult<T> = { ok: true; value: T } | { ok: false; reason: string }

/** Parse pasted workflow-API JSON into a validated graph, or a friendly reason. */
export function parseGraphText(text: string): BuildResult<WorkflowTemplate['graph']> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, reason: 'graph is not valid JSON' }
  }
  const parsed = graphSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, reason: 'not a valid workflow-API graph (each node needs class_type + inputs)' }
  return { ok: true, value: parsed.data }
}

/** Enumerate selectable binding targets: each node id with its input keys, deterministically sorted. */
export function graphTargets(graph: WorkflowTemplate['graph']): { node: string; inputs: string[] }[] {
  return Object.keys(graph)
    .sort()
    .map((node) => ({ node, inputs: Object.keys(graph[node].inputs).sort() }))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/lib/template-builder.test.ts`
Expected: PASS (all 5).

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/lib/template-builder.ts apps/control-plane/src/lib/template-builder.test.ts
git commit -m "feat(control-plane): parse pasted comfyui graph + enumerate binding targets"
```

---

## Task 3: Build + dry-run + `validateDraft` (the security heart)

**Files:**
- Modify: `apps/control-plane/src/lib/template-builder.ts`
- Test: `apps/control-plane/src/lib/template-builder.test.ts`

**Interfaces:**
- Consumes: `parseGraphText` (Task 2); `templateDraftSchema`, `TemplateDraft` (Task 1); `reconstructGraph`, `comfyuiConstraint`, `WorkflowTemplate`, `ParamSpec` from `@metamodels/connectors`.
- Produces:
  - `buildTemplate(draft: TemplateDraft): BuildResult<WorkflowTemplate>` — parse graph, assemble `{ id, graph, params, cost }`, validate the *whole* thing through `comfyuiConstraint` (so it is byte-identical to what the data-plane will re-parse), reject duplicate param names.
  - `dryRunTemplate(tpl: WorkflowTemplate): BuildResult<WorkflowTemplate['graph']>` — synthesize a sample value for every non-seed param and call `reconstructGraph`; returns the reconstructed graph on success, or the reconstruct `reason` on failure. Proves every declared target resolves.
  - `validateDraft(draft: unknown): BuildResult<WorkflowTemplate>` — `templateDraftSchema.parse` → `buildTemplate` → `dryRunTemplate`; returns the validated template. This is the single entry point the Server Action + service call.

**Why the dry-run matters:** `reconstructGraph` is the data-plane's security gate. Running it here with synthesized params proves, before save, that (a) every declared param targets a node/input that actually exists in the pasted graph, and (b) the template the operator built is one the runtime will accept. A mis-targeted param is caught at authoring time instead of at a consumer's request.

- [ ] **Step 1: Write the failing test**

```ts
// append to apps/control-plane/src/lib/template-builder.test.ts
import { buildTemplate, dryRunTemplate, validateDraft } from './template-builder'
import { reconstructGraph } from '@metamodels/connectors'

const FULL_GRAPH = {
  '3': { class_type: 'KSampler', inputs: { seed: 0, steps: 20 } },
  '4': { class_type: 'CLIPTextEncode', inputs: { text: '' } },
  '10': { class_type: 'LoadImage', inputs: { image: '' } },
}
const goodDraft = {
  id: 'txt2img',
  graphText: JSON.stringify(FULL_GRAPH),
  params: [
    { name: 'prompt', type: 'text', target: { node: '4', input: 'text' } },
    { name: 'seed', type: 'seed', targets: [{ node: '3', input: 'seed' }] },
    { name: 'steps', type: 'number', target: { node: '3', input: 'steps' }, min: 1, max: 50 },
    { name: 'source', type: 'image', target: { node: '10', input: 'image' } },
  ],
  cost: 2,
}

describe('buildTemplate', () => {
  test('assembles a WorkflowTemplate that validates against comfyuiConstraint', () => {
    const r = buildTemplate({ ...goodDraft, graphText: goodDraft.graphText } as never)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.id).toBe('txt2img')
      expect(r.value.params).toHaveLength(4)
      expect(r.value.cost).toBe(2)
    }
  })
  test('rejects a draft whose graph text is unparseable', () => {
    const r = buildTemplate({ ...goodDraft, graphText: '{ bad' } as never)
    expect(r.ok).toBe(false)
  })
  test('rejects duplicate param names', () => {
    const r = buildTemplate({
      ...goodDraft,
      params: [
        { name: 'p', type: 'text', target: { node: '4', input: 'text' } },
        { name: 'p', type: 'number', target: { node: '3', input: 'steps' } },
      ],
    } as never)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason.toLowerCase()).toContain('duplicate')
  })
})

describe('dryRunTemplate', () => {
  test('reconstructs a good template (all targets resolve)', () => {
    const b = buildTemplate(goodDraft as never)
    expect(b.ok).toBe(true)
    if (!b.ok) return
    const r = dryRunTemplate(b.value)
    expect(r.ok).toBe(true)
  })
  test('fails when a param targets a node that is not in the graph', () => {
    const b = buildTemplate({
      ...goodDraft,
      params: [{ name: 'prompt', type: 'text', target: { node: '999', input: 'text' } }],
    } as never)
    expect(b.ok).toBe(true) // shape is fine
    if (!b.ok) return
    const r = dryRunTemplate(b.value)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('999')
  })
})

describe('validateDraft — security invariants hold end-to-end', () => {
  test('a validated template rejects an UNDECLARED consumer param at reconstruct time', () => {
    const v = validateDraft(goodDraft)
    expect(v.ok).toBe(true)
    if (!v.ok) return
    const out = reconstructGraph(v.value, { prompt: 'hi', evil: 'x' }, {})
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.reason).toContain('unknown param')
  })
  test('SEED is server-generated: reconstruct fills the seed target even with no seed in consumer params', () => {
    const v = validateDraft(goodDraft)
    if (!v.ok) throw new Error('draft should be valid')
    const out = reconstructGraph(v.value, { prompt: 'hi' }, { uploads: { source: 'up.png' }, rng: () => 0.5 })
    expect(out.ok).toBe(true)
    if (out.ok) expect(typeof out.graph['3'].inputs.seed).toBe('number')
  })
  test('IMAGE resolves from the upload slot, not the consumer value', () => {
    const v = validateDraft(goodDraft)
    if (!v.ok) throw new Error('draft should be valid')
    const out = reconstructGraph(v.value, { prompt: 'hi', source: 'IGNORED' }, { uploads: { source: 'trusted.png' } })
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.graph['10'].inputs.image).toBe('trusted.png')
  })
  test('rejects the whole draft when a target does not resolve (dry-run gate)', () => {
    const bad = { ...goodDraft, params: [{ name: 'p', type: 'text', target: { node: 'NOPE', input: 'text' } }] }
    const v = validateDraft(bad)
    expect(v.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/lib/template-builder.test.ts`
Expected: FAIL — `buildTemplate`/`dryRunTemplate`/`validateDraft` are not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// append to apps/control-plane/src/lib/template-builder.ts
import { reconstructGraph, comfyuiConstraint, type ParamSpec } from '@metamodels/connectors'
import { templateDraftSchema, type TemplateDraft } from './template-schema'

/** Assemble a draft into a WorkflowTemplate and validate it exactly as the data-plane will. */
export function buildTemplate(draft: TemplateDraft): BuildResult<WorkflowTemplate> {
  const parsedGraph = parseGraphText(draft.graphText)
  if (!parsedGraph.ok) return parsedGraph

  const names = draft.params.map((p) => p.name)
  const dup = names.find((n, i) => names.indexOf(n) !== i)
  if (dup) return { ok: false, reason: `duplicate param name: ${dup}` }

  const candidate = { id: draft.id, graph: parsedGraph.value, params: draft.params, cost: draft.cost }
  // Validate against the breed's own constraint so what we store is byte-identical
  // to what the data-plane re-parses. `.templates[0]` is the built template.
  const checked = comfyuiConstraint.safeParse({ templates: [candidate] })
  if (!checked.success) return { ok: false, reason: checked.error.issues[0]?.message ?? 'invalid template' }
  return { ok: true, value: checked.data.templates[0] }
}

/** Synthesize a sample value per non-seed param and reconstruct — proves every target resolves. */
export function dryRunTemplate(tpl: WorkflowTemplate): BuildResult<WorkflowTemplate['graph']> {
  const params: Record<string, unknown> = {}
  const uploads: Record<string, string> = {}
  for (const spec of tpl.params) sampleParam(spec, params, uploads)
  const out = reconstructGraph(tpl, params, { uploads, rng: () => 0.5 })
  if (!out.ok) return { ok: false, reason: out.reason }
  return { ok: true, value: out.graph }
}

function sampleParam(spec: ParamSpec, params: Record<string, unknown>, uploads: Record<string, string>): void {
  // seed is auto-generated by reconstructGraph — never supply it as a consumer value.
  if (spec.type === 'seed') return
  if (spec.type === 'text') params[spec.name] = 'sample'
  else if (spec.type === 'number') params[spec.name] = spec.min ?? 0
  else if (spec.type === 'image') {
    params[spec.name] = 'sample' // presence forces the image branch
    uploads[spec.name] = 'dry-run.png'
  }
}

/** Single entry point: parse the draft shape, build, and dry-run. Returns the storable template. */
export function validateDraft(draft: unknown): BuildResult<WorkflowTemplate> {
  const parsed = templateDraftSchema.safeParse(draft)
  if (!parsed.success) return { ok: false, reason: parsed.error.issues[0]?.message ?? 'invalid draft' }
  const built = buildTemplate(parsed.data)
  if (!built.ok) return built
  const dry = dryRunTemplate(built.value)
  if (!dry.ok) return dry
  return built
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/lib/template-builder.test.ts`
Expected: PASS (all builder + invariant tests).

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/lib/template-builder.ts apps/control-plane/src/lib/template-builder.test.ts
git commit -m "feat(control-plane): build+dry-run comfyui templates, proving reconstructGraph invariants at authoring time"
```

---

## Task 4: `templates-service.ts` (org-scoped, constraint-only persistence)

**Files:**
- Modify: `apps/control-plane/src/server/fences-service.ts` (export `paddockBreedInOrg`)
- Create: `apps/control-plane/src/server/templates-service.ts`
- Test: `apps/control-plane/src/server/templates-service.test.ts`

**Interfaces:**
- Consumes: `paddockBreedInOrg` (now exported from `fences-service`), `NotFoundError` from `fences-service`; `requireCapability`, `Actor` from `../auth/authorize`; `writeAudit`; `validateDraft` (Task 3); `comfyuiConstraint`, `WorkflowTemplate` from `@metamodels/connectors`; `fence` table + `Db`.
- Produces:
  - `saveTemplate(db, actor, { paddockId, draft }): Promise<WorkflowTemplate[]>` — validate the draft, upsert it (replace by `id`, else append) into the paddock's `constraint_json.templates`, write **only** the `constraint_json` column, audit `template.save`, return the new templates array.
  - `deleteTemplate(db, actor, { paddockId, templateId }): Promise<WorkflowTemplate[]>` — remove by id, audit `template.delete`, return the remaining templates.
  - `listTemplates(db, actor, paddockId): Promise<WorkflowTemplate[]>` — read helper (org-scoped, read capability) for the page.

**Design notes:**
- **comfyui-only:** `paddockBreedInOrg` returns the breed; if it is not `comfyui`, throw `NotFoundError` (Ollama paddocks have no templates; treat as not-found to avoid leaking).
- **constraint-only writes** so rate-limit/quota set by the 9c editor are never clobbered: on insert supply `rateLimit: null, quota: null`; on conflict set **only** `constraintJson`.
- Validate the final `{ templates }` through `comfyuiConstraint` before writing (defense in depth beyond `validateDraft`).

- [ ] **Step 1: Export `paddockBreedInOrg` from fences-service**

In `apps/control-plane/src/server/fences-service.ts`, change the helper signature from `async function paddockBreedInOrg(` to `export async function paddockBreedInOrg(` (no other change).

- [ ] **Step 2: Write the failing test**

```ts
// apps/control-plane/src/server/templates-service.test.ts
import { describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '@metamodels/schema'
import { freshDb, seedOrg } from '../test/db'
import { saveTemplate, deleteTemplate, listTemplates } from './templates-service'
import { NotFoundError } from './fences-service'
import { ForbiddenError, type Actor } from '../auth/authorize'

type TDb = Awaited<ReturnType<typeof freshDb>>
const GRAPH = { '4': { class_type: 'CLIPTextEncode', inputs: { text: '' } } }
const draft = (id: string) => ({
  id, graphText: JSON.stringify(GRAPH),
  params: [{ name: 'prompt', type: 'text', target: { node: '4', input: 'text' } }], cost: 1,
})

async function comfyPaddock(db: TDb, role: Actor['role'] = 'admin') {
  const o = await seedOrg(db)
  const [f] = await db.insert(schema.flock).values({ orgId: o.id, breed: 'comfyui', name: 'f', baseUrl: 'http://x' }).returning()
  const [p] = await db.insert(schema.paddock).values({ orgId: o.id, flockId: f.id, slug: 's', name: 'P' }).returning()
  const actor: Actor = { id: 'u1', orgId: o.id, email: `${role}@x.io`, role }
  return { o, f, p, actor }
}

describe('templates-service', () => {
  test('saves a template into the fence constraint_json and audits template.save', async () => {
    const db = await freshDb()
    const { p, actor } = await comfyPaddock(db)
    const tpls = await saveTemplate(db, actor, { paddockId: p.id, draft: draft('txt2img') })
    expect(tpls.map((t) => t.id)).toEqual(['txt2img'])
    const [row] = await db.select().from(schema.fence).where(eq(schema.fence.paddockId, p.id))
    expect((row.constraintJson as { templates: unknown[] }).templates).toHaveLength(1)
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'template.save'))
    expect(audits).toHaveLength(1)
  })

  test('saving the same id replaces it; a new id appends', async () => {
    const db = await freshDb()
    const { p, actor } = await comfyPaddock(db)
    await saveTemplate(db, actor, { paddockId: p.id, draft: draft('a') })
    await saveTemplate(db, actor, { paddockId: p.id, draft: { ...draft('a'), cost: 9 } })
    const two = await saveTemplate(db, actor, { paddockId: p.id, draft: draft('b') })
    expect(two.map((t) => t.id)).toEqual(['a', 'b'])
    expect(two.find((t) => t.id === 'a')!.cost).toBe(9)
    expect(await db.select().from(schema.fence)).toHaveLength(1)
  })

  test('preserves existing rateLimit/quota when writing templates', async () => {
    const db = await freshDb()
    const { p, actor } = await comfyPaddock(db)
    await db.insert(schema.fence).values({
      orgId: actor.orgId, paddockId: p.id, constraintJson: { templates: [] } as never,
      rateLimit: { windowSec: 60, max: 5 } as never, quota: [{ dim: 'jobs', max: 10, period: 'day' }] as never,
    })
    await saveTemplate(db, actor, { paddockId: p.id, draft: draft('a') })
    const [row] = await db.select().from(schema.fence).where(eq(schema.fence.paddockId, p.id))
    expect(row.rateLimit).toEqual({ windowSec: 60, max: 5 })
    expect(row.quota).toEqual([{ dim: 'jobs', max: 10, period: 'day' }])
  })

  test('deleteTemplate removes by id and audits template.delete', async () => {
    const db = await freshDb()
    const { p, actor } = await comfyPaddock(db)
    await saveTemplate(db, actor, { paddockId: p.id, draft: draft('a') })
    await saveTemplate(db, actor, { paddockId: p.id, draft: draft('b') })
    const left = await deleteTemplate(db, actor, { paddockId: p.id, templateId: 'a' })
    expect(left.map((t) => t.id)).toEqual(['b'])
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'template.delete'))
    expect(audits).toHaveLength(1)
  })

  test('rejects an invalid draft before any write', async () => {
    const db = await freshDb()
    const { p, actor } = await comfyPaddock(db)
    await expect(saveTemplate(db, actor, {
      paddockId: p.id, draft: { ...draft('x'), params: [{ name: 'p', type: 'text', target: { node: 'NOPE', input: 'text' } }] },
    })).rejects.toThrow()
    expect(await db.select().from(schema.fence)).toHaveLength(0)
  })

  test('rejects a non-comfyui paddock as not-found', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const [f] = await db.insert(schema.flock).values({ orgId: o.id, breed: 'ollama', name: 'f', baseUrl: 'http://x' }).returning()
    const [p] = await db.insert(schema.paddock).values({ orgId: o.id, flockId: f.id, slug: 's', name: 'P' }).returning()
    const actor: Actor = { id: 'u1', orgId: o.id, email: 'a@x.io', role: 'admin' }
    await expect(saveTemplate(db, actor, { paddockId: p.id, draft: draft('x') })).rejects.toThrow(NotFoundError)
  })

  test('rejects a paddock in another org as not-found', async () => {
    const db = await freshDb()
    const { p } = await comfyPaddock(db)
    const other = await seedOrg(db)
    const actor: Actor = { id: 'u2', orgId: other.id, email: 'b@x.io', role: 'admin' }
    await expect(saveTemplate(db, actor, { paddockId: p.id, draft: draft('x') })).rejects.toThrow(NotFoundError)
  })

  test('viewer cannot save a template', async () => {
    const db = await freshDb()
    const { p, actor } = await comfyPaddock(db, 'viewer')
    await expect(saveTemplate(db, actor, { paddockId: p.id, draft: draft('x') })).rejects.toThrow(ForbiddenError)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/templates-service.test.ts`
Expected: FAIL — cannot find module `./templates-service`.

- [ ] **Step 4: Write minimal implementation**

```ts
// apps/control-plane/src/server/templates-service.ts
import { and, eq } from 'drizzle-orm'
import { comfyuiConstraint, type WorkflowTemplate } from '@metamodels/connectors'
import { fence } from '@metamodels/schema'
import type { Db } from './db'
import { requireCapability, type Actor } from '../auth/authorize'
import { writeAudit } from './audit'
import { NotFoundError, paddockBreedInOrg } from './fences-service'
import { validateDraft } from '../lib/template-builder'

/** Load the current templates for an org-scoped comfyui paddock. Throws NotFoundError otherwise. */
async function currentTemplates(tx: Db, actor: Actor, paddockId: string): Promise<WorkflowTemplate[]> {
  const breed = await paddockBreedInOrg(tx, actor, paddockId)
  if (breed !== 'comfyui') throw new NotFoundError(`comfyui paddock ${paddockId}`)
  const [row] = await tx.select().from(fence).where(eq(fence.paddockId, paddockId)).limit(1)
  if (!row) return []
  return comfyuiConstraint.parse(row.constraintJson).templates
}

/** Persist `templates` into the paddock's fence, writing ONLY constraint_json (rate/quota preserved). */
async function writeTemplates(tx: Db, actor: Actor, paddockId: string, templates: WorkflowTemplate[]): Promise<void> {
  const constraintJson = comfyuiConstraint.parse({ templates })
  await tx
    .insert(fence)
    .values({
      orgId: actor.orgId, paddockId,
      constraintJson: constraintJson as never, rateLimit: null as never, quota: null as never,
    })
    .onConflictDoUpdate({ target: fence.paddockId, set: { constraintJson: constraintJson as never } })
}

export async function listTemplates(db: Db, actor: Actor, paddockId: string): Promise<WorkflowTemplate[]> {
  requireCapability(actor, 'read')
  return currentTemplates(db, actor, paddockId)
}

export async function saveTemplate(
  db: Db, actor: Actor, input: { paddockId: string; draft: unknown },
): Promise<WorkflowTemplate[]> {
  requireCapability(actor, 'resource.write')
  const validated = validateDraft(input.draft)
  if (!validated.ok) throw new Error(validated.reason)
  const tpl = validated.value

  return db.transaction(async (tx) => {
    const existing = await currentTemplates(tx, actor, input.paddockId)
    const next = existing.some((t) => t.id === tpl.id)
      ? existing.map((t) => (t.id === tpl.id ? tpl : t))
      : [...existing, tpl]
    await writeTemplates(tx, actor, input.paddockId, next)
    await writeAudit(tx, {
      orgId: actor.orgId, actor: actor.email, action: 'template.save',
      target: `paddock:${input.paddockId}`, detail: { templateId: tpl.id },
    })
    return next
  })
}

export async function deleteTemplate(
  db: Db, actor: Actor, input: { paddockId: string; templateId: string },
): Promise<WorkflowTemplate[]> {
  requireCapability(actor, 'resource.write')
  return db.transaction(async (tx) => {
    const existing = await currentTemplates(tx, actor, input.paddockId)
    const next = existing.filter((t) => t.id !== input.templateId)
    await writeTemplates(tx, actor, input.paddockId, next)
    await writeAudit(tx, {
      orgId: actor.orgId, actor: actor.email, action: 'template.delete',
      target: `paddock:${input.paddockId}`, detail: { templateId: input.templateId },
    })
    return next
  })
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/templates-service.test.ts`
Expected: PASS (all 8).

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane/src/server/templates-service.ts apps/control-plane/src/server/templates-service.test.ts apps/control-plane/src/server/fences-service.ts
git commit -m "feat(control-plane): templates-service — org-scoped, comfyui-only, constraint-only writes with audit"
```

---

## Task 5: Stop the 9c fence editor from owning ComfyUI templates (kill round-trip + clobber)

**Files:**
- Modify: `apps/control-plane/src/lib/fence-schema.ts`
- Modify: `apps/control-plane/src/server/fences-service.ts`
- Modify: `apps/control-plane/src/server/fences-service.test.ts`
- Modify: `apps/control-plane/src/app/(app)/paddocks/[id]/fence/actions.ts`
- Modify: `apps/control-plane/src/app/(app)/paddocks/[id]/fence/fence-client.tsx`

**Interfaces:**
- Produces (changed contract): `saveFence` now treats `constraintJson` as **optional**. When omitted, it **preserves** the fence's stored `constraint_json` (on update) or applies the breed default `{ templates: [] }` (on a comfyui insert). Ollama callers always pass `constraintJson`, so their behavior is unchanged.

**Why:** In Plan 5.2 the 9c editor round-tripped the whole `{templates:[…]}` through a hidden field so a rate/quota edit wouldn't erase templates. With 8b now owning templates, that round-trip both bloats the page HTML and would *clobber* an 8b edit with the stale templates captured at page load. Making `constraintJson` preserve-on-omit lets the 9c editor write only rate/quota for comfyui.

- [ ] **Step 1: Write the failing test (preserve-on-omit)**

```ts
// append to apps/control-plane/src/server/fences-service.test.ts
test('omitting constraintJson preserves the stored constraint (comfyui rate/quota edit)', async () => {
  const db = await freshDb()
  const o = await seedOrg(db)
  const [f] = await db.insert(schema.flock).values({ orgId: o.id, breed: 'comfyui', name: 'f', baseUrl: 'http://x' }).returning()
  const [p] = await db.insert(schema.paddock).values({ orgId: o.id, flockId: f.id, slug: 's', name: 'P' }).returning()
  const actor: Actor = { id: 'u1', orgId: o.id, email: 'a@x.io', role: 'admin' }
  // Seed a fence that already has a template.
  await db.insert(schema.fence).values({
    orgId: o.id, paddockId: p.id,
    constraintJson: { templates: [{ id: 'txt2img', graph: {}, params: [], cost: 1 }] } as never,
  })
  // Save rate/quota only — no constraintJson.
  await saveFence(db, actor, registry, { paddockId: p.id, rateLimit: { windowSec: 60, max: 3 } })
  const got = await getFence(db, actor, p.id)
  expect((got!.constraintJson as { templates: unknown[] }).templates).toHaveLength(1) // preserved
  expect(got!.rateLimit).toEqual({ windowSec: 60, max: 3 })
})

test('omitting constraintJson on a fresh comfyui fence applies the empty-templates default', async () => {
  const db = await freshDb()
  const o = await seedOrg(db)
  const [f] = await db.insert(schema.flock).values({ orgId: o.id, breed: 'comfyui', name: 'f', baseUrl: 'http://x' }).returning()
  const [p] = await db.insert(schema.paddock).values({ orgId: o.id, flockId: f.id, slug: 's', name: 'P' }).returning()
  const actor: Actor = { id: 'u1', orgId: o.id, email: 'a@x.io', role: 'admin' }
  const saved = await saveFence(db, actor, registry, { paddockId: p.id, rateLimit: { windowSec: 60, max: 3 } })
  expect((saved.constraintJson as { templates: unknown[] }).templates).toEqual([])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/fences-service.test.ts`
Expected: FAIL — current `saveFence` calls `validateConstraintForBreed(registry, breedId, undefined)`, which throws on comfyui (object expected).

- [ ] **Step 3: Make `constraintJson` explicitly optional in the schema**

In `apps/control-plane/src/lib/fence-schema.ts`, replace the `saveFenceInput` definition with:

```ts
export const saveFenceInput = z.object({
  paddockId: z.string().uuid(),
  // Optional: when omitted, saveFence preserves the fence's stored constraint
  // (or applies the breed default on a fresh row). Validated per-breed on write.
  constraintJson: z.unknown().optional(),
  rateLimit: rateLimitSchema.nullish(),
  quota: quotaSchema.nullish(),
})
```

- [ ] **Step 4: Implement preserve-on-omit in `saveFence`**

In `apps/control-plane/src/server/fences-service.ts`, replace the body of `saveFence`'s transaction so the constraint is resolved before the upsert and the upsert only sets `constraintJson` when the caller supplied one:

```ts
export async function saveFence(
  db: Db, actor: Actor, registry: BreedRegistry, input: unknown,
): Promise<Fence> {
  requireCapability(actor, 'resource.write')
  const data = saveFenceInput.parse(input) // validates rateLimit + quota shapes

  return db.transaction(async (tx) => {
    const breedId = await paddockBreedInOrg(tx, actor, data.paddockId)
    const provided = data.constraintJson !== undefined

    // Resolve the constraint to store on INSERT: provided → validate it;
    // omitted → existing row's constraint, else the breed default.
    let insertConstraint: unknown
    if (provided) {
      insertConstraint = validateConstraintForBreed(registry, breedId, data.constraintJson)
    } else {
      const [existing] = await tx.select().from(fence).where(eq(fence.paddockId, data.paddockId)).limit(1)
      insertConstraint = existing
        ? existing.constraintJson
        : registry.get(breedId).constraintSchema.parse({}) // breed default (comfyui → {templates:[]})
    }

    // On CONFLICT, only overwrite constraint_json when the caller actually sent one.
    const conflictSet: Record<string, unknown> = {
      rateLimit: (data.rateLimit ?? null) as never,
      quota: (data.quota ?? null) as never,
    }
    if (provided) conflictSet.constraintJson = insertConstraint as never

    const [saved] = await tx
      .insert(fence)
      .values({
        orgId: actor.orgId,
        paddockId: data.paddockId,
        constraintJson: insertConstraint as never,
        rateLimit: (data.rateLimit ?? null) as never,
        quota: (data.quota ?? null) as never,
      })
      .onConflictDoUpdate({ target: fence.paddockId, set: conflictSet })
      .returning()

    await writeAudit(tx, {
      orgId: actor.orgId, actor: actor.email, action: 'fence.save',
      target: `paddock:${data.paddockId}`, detail: { breed: breedId },
    })
    return saved
  })
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/fences-service.test.ts`
Expected: PASS (existing fence tests + the 2 new preserve-on-omit tests).

- [ ] **Step 6: Remove the round-trip from the 9c action**

In `apps/control-plane/src/app/(app)/paddocks/[id]/fence/actions.ts`, replace the constraint-building block so the comfyui branch sends no `constraintJson`:

```ts
    // Build constraint_json per breed from the form.
    // ComfyUI: templates are managed on the Templates screen (8b); omit constraintJson
    // entirely so saveFence preserves whatever templates already exist.
    let constraintJson: unknown
    if (breed !== 'comfyui') {
      const routes = fd.getAll('route').map(String)
      const modelsRaw = String(fd.get('models') ?? '').trim()
      const allowedModels = modelsRaw ? modelsRaw.split(',').map((m) => m.trim()).filter(Boolean) : null
      constraintJson = { allowedRoutes: routes, allowedModels }
    }
    // ... rateLimit / quota unchanged ...
    await saveFence(getDb(), actor, registry, { paddockId, constraintJson, rateLimit, quota })
```

(`constraintJson` is `undefined` for comfyui; `saveFenceInput` now accepts that and `saveFence` preserves the stored templates.)

- [ ] **Step 7: Replace the hidden field with a Templates link in the 9c client**

In `apps/control-plane/src/app/(app)/paddocks/[id]/fence/fence-client.tsx`, replace the comfyui `<div>` block (the "coming in Plan 5.3" note + hidden input) with:

```tsx
          {paddock.breed === 'comfyui' ? (
            <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-4 text-sm text-[var(--color-muted)]">
              Workflow templates for this ComfyUI paddock are authored in the{' '}
              <Link href={`/paddocks/${paddock.id}/templates`} className="text-[var(--color-primary)] hover:underline">
                Template editor →
              </Link>
              . Rate limit and quota still apply below.
            </div>
          ) : (
```

(Delete the `<input type="hidden" name="constraintJson" …>` line entirely. `Link` is already imported.)

- [ ] **Step 8: Typecheck + commit**

Run: `pnpm --filter @metamodels/control-plane exec tsc --noEmit`
Expected: no errors.

```bash
git add apps/control-plane/src/lib/fence-schema.ts apps/control-plane/src/server/fences-service.ts apps/control-plane/src/server/fences-service.test.ts apps/control-plane/src/app/\(app\)/paddocks/\[id\]/fence/actions.ts apps/control-plane/src/app/\(app\)/paddocks/\[id\]/fence/fence-client.tsx
git commit -m "refactor(control-plane): fence editor no longer owns comfyui templates (preserve-on-omit constraint)"
```

---

## Task 6: Screen 8b route — RSC page + Server Actions

**Files:**
- Create: `apps/control-plane/src/app/(app)/paddocks/[id]/templates/page.tsx`
- Create: `apps/control-plane/src/app/(app)/paddocks/[id]/templates/actions.ts`

**Interfaces:**
- Consumes: `requireUser`, `getDb`, `authorize`, `requireCapability`; `listPaddocks`, `listFlocks`; `listTemplates`, `saveTemplate`, `deleteTemplate` (Task 4); `validateDraft` (Task 3); `TemplatesClient` (Task 7).
- Produces (Server Actions):
  - `saveTemplateAction(_prev, fd): Promise<{ error?: string; ok?: boolean }>`
  - `deleteTemplateAction(_prev, fd): Promise<{ error?: string; ok?: boolean }>`
  - `dryRunTemplateAction(draft): Promise<{ ok: boolean; reason?: string }>` — validate-only (no write) for the "Validate" button.

**Draft transport:** the client serializes the whole draft to JSON in a hidden `draft` form field; the actions `JSON.parse` it and hand it to the service (which re-validates). This mirrors the existing `constraintJson` JSON-in-a-field pattern.

- [ ] **Step 1: Create the Server Actions**

```ts
// apps/control-plane/src/app/(app)/paddocks/[id]/templates/actions.ts
'use server'
import { revalidatePath } from 'next/cache'
import { getDb } from '../../../../../server/db'
import { requireUser } from '../../../../../server/guard'
import { requireCapability } from '../../../../../auth/authorize'
import { saveTemplate, deleteTemplate } from '../../../../../server/templates-service'
import { validateDraft } from '../../../../../lib/template-builder'

export async function saveTemplateAction(_prev: unknown, fd: FormData): Promise<{ error?: string; ok?: boolean }> {
  const actor = await requireUser()
  const paddockId = String(fd.get('paddockId') ?? '')
  try {
    requireCapability(actor, 'resource.write')
    const draft = JSON.parse(String(fd.get('draft') ?? '{}'))
    await saveTemplate(getDb(), actor, { paddockId, draft })
    revalidatePath(`/paddocks/${paddockId}/templates`)
    return { ok: true }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed to save template' }
  }
}

export async function deleteTemplateAction(_prev: unknown, fd: FormData): Promise<{ error?: string; ok?: boolean }> {
  const actor = await requireUser()
  const paddockId = String(fd.get('paddockId') ?? '')
  const templateId = String(fd.get('templateId') ?? '')
  try {
    requireCapability(actor, 'resource.write')
    await deleteTemplate(getDb(), actor, { paddockId, templateId })
    revalidatePath(`/paddocks/${paddockId}/templates`)
    return { ok: true }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed to delete template' }
  }
}

/** Validate-only: prove the draft builds + reconstructs without persisting. */
export async function dryRunTemplateAction(draft: unknown): Promise<{ ok: boolean; reason?: string }> {
  const actor = await requireUser()
  requireCapability(actor, 'read')
  const r = validateDraft(draft)
  return r.ok ? { ok: true } : { ok: false, reason: r.reason }
}
```

- [ ] **Step 2: Create the RSC page**

```tsx
// apps/control-plane/src/app/(app)/paddocks/[id]/templates/page.tsx
import { notFound } from 'next/navigation'
import { getDb } from '../../../../../server/db'
import { requireUser } from '../../../../../server/guard'
import { authorize } from '../../../../../auth/authorize'
import { listPaddocks } from '../../../../../server/paddocks-service'
import { listFlocks } from '../../../../../server/flocks-service'
import { listTemplates } from '../../../../../server/templates-service'
import { TemplatesClient } from './templates-client'

export default async function TemplatesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const actor = await requireUser()
  const db = getDb()
  const paddocks = await listPaddocks(db, actor)
  const paddock = paddocks.find((p) => p.id === id)
  if (!paddock) notFound()
  const flocks = await listFlocks(db, actor)
  const breed = flocks.find((f) => f.id === paddock.flockId)?.breed ?? 'ollama'
  if (breed !== 'comfyui') notFound() // templates are a comfyui-only screen

  const templates = await listTemplates(db, actor, id)

  return (
    <TemplatesClient
      canWrite={authorize(actor, 'resource.write')}
      paddock={{ id: paddock.id, name: paddock.name, slug: paddock.slug }}
      templates={templates}
    />
  )
}
```

- [ ] **Step 3: Typecheck (page will fail until Task 7 supplies `TemplatesClient`)**

Run: `pnpm --filter @metamodels/control-plane exec tsc --noEmit`
Expected: the only error is the missing `./templates-client` module — resolved in Task 7. (Actions typecheck clean.)

- [ ] **Step 4: Commit**

```bash
git add apps/control-plane/src/app/\(app\)/paddocks/\[id\]/templates/actions.ts apps/control-plane/src/app/\(app\)/paddocks/\[id\]/templates/page.tsx
git commit -m "feat(control-plane): screen 8b route — templates page shell + save/delete/dry-run actions"
```

---

## Task 7: Screen 8b editor UI (`templates-client.tsx`)

**Files:**
- Create: `apps/control-plane/src/app/(app)/paddocks/[id]/templates/templates-client.tsx`

**Interfaces:**
- Consumes: `saveTemplateAction`, `deleteTemplateAction`, `dryRunTemplateAction` (Task 6); `parseGraphText`, `graphTargets` (Task 2); `TemplateDraft` (Task 1); `WorkflowTemplate`, `ParamSpec` from `@metamodels/connectors`; existing UI primitives (`Button`, `Input`, `Label`, `Select`, `PageHeader`, `cn`).
- Produces: `export function TemplatesClient({ paddock, templates, canWrite })`.

**Behavior:**
- Left column: existing templates list — id, param count, cost; Edit (loads into the form) and Delete (posts `deleteTemplateAction`) per row, gated by `canWrite`.
- Right column: the editor form.
  - Inputs: `id`, `cost`, and a `graphText` `<textarea>` for the pasted graph.
  - A **Parse graph** button runs `parseGraphText(graphText)` client-side; on success it stores the target list from `graphTargets(...)`; on failure it shows the reason. (Pure lib import — no server call.)
  - Param rows: each has a `name`, a `type` `<select>` (text/seed/number/image), and node/input `<select>`s populated from the parsed targets. `number` shows optional min/max; `seed` shows a repeatable list of targets with add/remove. Add-param / remove-param buttons.
  - A **Validate** button serializes the draft and calls `dryRunTemplateAction`; shows ✓ "reconstructs OK" or ✗ reason.
  - **Save** posts the serialized draft via `saveTemplateAction`.
- Client draft type mirrors `TemplateDraft`; the client builds `params: ParamSpec[]` from row state before serializing.

- [ ] **Step 1: Implement the client component**

```tsx
// apps/control-plane/src/app/(app)/paddocks/[id]/templates/templates-client.tsx
'use client'
import { useState } from 'react'
import Link from 'next/link'
import type { ParamSpec, WorkflowTemplate } from '@metamodels/connectors'
import { PageHeader } from '../../../../../components/page-header'
import { Button } from '../../../../../components/ui/button'
import { Input } from '../../../../../components/ui/input'
import { Label } from '../../../../../components/ui/label'
import { Select } from '../../../../../components/ui/select'
import { parseGraphText, graphTargets } from '../../../../../lib/template-builder'
import { saveTemplateAction, deleteTemplateAction, dryRunTemplateAction } from './actions'

type ParamType = ParamSpec['type']
interface Row { name: string; type: ParamType; node: string; input: string; min?: string; max?: string; seedTargets: { node: string; input: string }[] }
type Targets = { node: string; inputs: string[] }[]

const PARAM_TYPES: ParamType[] = ['text', 'seed', 'number', 'image']

function toParamSpec(r: Row): ParamSpec {
  if (r.type === 'seed') return { name: r.name, type: 'seed', targets: r.seedTargets.map((t) => ({ node: t.node, input: t.input })) }
  if (r.type === 'number') {
    const spec: ParamSpec = { name: r.name, type: 'number', target: { node: r.node, input: r.input } }
    if (r.min !== undefined && r.min !== '') spec.min = Number(r.min)
    if (r.max !== undefined && r.max !== '') spec.max = Number(r.max)
    return spec
  }
  if (r.type === 'image') return { name: r.name, type: 'image', target: { node: r.node, input: r.input } }
  return { name: r.name, type: 'text', target: { node: r.node, input: r.input } }
}

function specToRow(s: ParamSpec): Row {
  if (s.type === 'seed') return { name: s.name, type: 'seed', node: '', input: '', seedTargets: s.targets.map((t) => ({ ...t })) }
  const base = { name: s.name, node: s.target.node, input: s.target.input, seedTargets: [] as Row['seedTargets'] }
  if (s.type === 'number') return { ...base, type: 'number', min: s.min?.toString() ?? '', max: s.max?.toString() ?? '' }
  return { ...base, type: s.type }
}

export function TemplatesClient({
  paddock, templates, canWrite,
}: {
  paddock: { id: string; name: string; slug: string }
  templates: WorkflowTemplate[]
  canWrite: boolean
}) {
  const [id, setId] = useState('')
  const [cost, setCost] = useState('1')
  const [graphText, setGraphText] = useState('')
  const [targets, setTargets] = useState<Targets>([])
  const [rows, setRows] = useState<Row[]>([])
  const [parseErr, setParseErr] = useState<string | undefined>()
  const [dry, setDry] = useState<{ ok: boolean; reason?: string } | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [saved, setSaved] = useState(false)

  function loadTemplate(t: WorkflowTemplate) {
    setId(t.id); setCost(String(t.cost)); const gt = JSON.stringify(t.graph, null, 2); setGraphText(gt)
    const parsed = parseGraphText(gt); setTargets(parsed.ok ? graphTargets(parsed.value) : [])
    setRows(t.params.map(specToRow)); setParseErr(undefined); setDry(undefined); setError(undefined); setSaved(false)
  }
  function onParse() {
    const r = parseGraphText(graphText)
    if (!r.ok) { setParseErr(r.reason); setTargets([]); return }
    setParseErr(undefined); setTargets(graphTargets(r.value))
  }
  function draft() { return { id, graphText, params: rows.map(toParamSpec), cost: Number(cost) } }
  async function onValidate() { setDry(await dryRunTemplateAction(draft())) }
  function addRow() { setRows((rs) => [...rs, { name: '', type: 'text', node: '', input: '', seedTargets: [{ node: '', input: '' }] }]) }
  function setRow(i: number, patch: Partial<Row>) { setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r))) }
  function removeRow(i: number) { setRows((rs) => rs.filter((_, j) => j !== i)) }

  async function onSave(fd: FormData) {
    setError(undefined); setSaved(false)
    fd.set('draft', JSON.stringify(draft()))
    const r = await saveTemplateAction(null, fd)
    if (r.error) setError(r.error); else setSaved(true)
  }

  const inputsFor = (node: string) => targets.find((t) => t.node === node)?.inputs ?? []

  return (
    <div>
      <PageHeader
        title={`Templates — ${paddock.name}`}
        subtitle={`ComfyUI workflow templates for /p/${paddock.slug}`}
        actions={<Link href="/paddocks" className="text-sm text-[var(--color-muted)] hover:underline">← Paddocks</Link>}
      />
      <div className="grid grid-cols-[280px_1fr] gap-6">
        <aside className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">Templates ({templates.length})</h2>
          {templates.length === 0 && <p className="text-sm text-[var(--color-muted)]">None yet. Paste a workflow →</p>}
          {templates.map((t) => (
            <div key={t.id} className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3 text-sm">
              <div className="font-mono">{t.id}</div>
              <div className="text-[var(--color-muted)]">{t.params.length} params · cost {t.cost}</div>
              {canWrite && (
                <div className="mt-2 flex gap-2">
                  <button type="button" className="text-[var(--color-primary)] hover:underline" onClick={() => loadTemplate(t)}>Edit</button>
                  <form action={deleteTemplateAction.bind(null, null)}>
                    <input type="hidden" name="paddockId" value={paddock.id} />
                    <input type="hidden" name="templateId" value={t.id} />
                    <button type="submit" className="text-[var(--color-danger)] hover:underline">Delete</button>
                  </form>
                </div>
              )}
            </div>
          ))}
        </aside>

        <form action={onSave} className="flex flex-col gap-4">
          <input type="hidden" name="paddockId" value={paddock.id} />
          <div className="flex gap-3">
            <div className="flex-1"><Label htmlFor="tid">Template id</Label><Input id="tid" value={id} onChange={(e) => setId(e.target.value)} placeholder="txt2img" /></div>
            <div className="w-28"><Label htmlFor="tcost">Cost</Label><Input id="tcost" type="number" min={0} value={cost} onChange={(e) => setCost(e.target.value)} /></div>
          </div>

          <div>
            <Label htmlFor="graph">Workflow-API JSON</Label>
            <textarea id="graph" value={graphText} onChange={(e) => setGraphText(e.target.value)} rows={8}
              className="w-full rounded-[var(--radius-input)] border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-xs" />
            <div className="mt-2 flex items-center gap-3">
              <Button type="button" variant="secondary" onClick={onParse}>Parse graph</Button>
              {parseErr && <span className="text-sm text-[var(--color-danger)]">{parseErr}</span>}
              {!parseErr && targets.length > 0 && <span className="text-sm text-[var(--color-muted)]">{targets.length} nodes parsed</span>}
            </div>
          </div>

          <fieldset className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-4">
            <legend className="px-1 text-sm font-semibold">Parameters</legend>
            {rows.map((r, i) => (
              <div key={i} className="mb-3 flex flex-wrap items-end gap-2 border-b border-[var(--color-border)] pb-3">
                <div><Label htmlFor={`n${i}`}>name</Label><Input id={`n${i}`} value={r.name} onChange={(e) => setRow(i, { name: e.target.value })} /></div>
                <div><Label htmlFor={`t${i}`}>type</Label>
                  <Select id={`t${i}`} value={r.type} onChange={(e) => setRow(i, { type: e.target.value as ParamType })}>
                    {PARAM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </Select>
                </div>
                {r.type === 'seed' ? (
                  <div className="text-xs text-[var(--color-muted)]">seed is server-generated each run — declare its target node(s):
                    {r.seedTargets.map((st, k) => (
                      <div key={k} className="mt-1 flex gap-1">
                        <Select value={st.node} onChange={(e) => setRow(i, { seedTargets: r.seedTargets.map((x, j) => j === k ? { ...x, node: e.target.value, input: '' } : x) })}>
                          <option value="">node</option>{targets.map((t) => <option key={t.node} value={t.node}>{t.node}</option>)}
                        </Select>
                        <Select value={st.input} onChange={(e) => setRow(i, { seedTargets: r.seedTargets.map((x, j) => j === k ? { ...x, input: e.target.value } : x) })}>
                          <option value="">input</option>{inputsFor(st.node).map((inp) => <option key={inp} value={inp}>{inp}</option>)}
                        </Select>
                      </div>
                    ))}
                    <button type="button" className="mt-1 text-[var(--color-primary)]" onClick={() => setRow(i, { seedTargets: [...r.seedTargets, { node: '', input: '' }] })}>+ target</button>
                  </div>
                ) : (
                  <>
                    <div><Label htmlFor={`nd${i}`}>node</Label>
                      <Select id={`nd${i}`} value={r.node} onChange={(e) => setRow(i, { node: e.target.value, input: '' })}>
                        <option value="">—</option>{targets.map((t) => <option key={t.node} value={t.node}>{t.node}</option>)}
                      </Select>
                    </div>
                    <div><Label htmlFor={`in${i}`}>input</Label>
                      <Select id={`in${i}`} value={r.input} onChange={(e) => setRow(i, { input: e.target.value })}>
                        <option value="">—</option>{inputsFor(r.node).map((inp) => <option key={inp} value={inp}>{inp}</option>)}
                      </Select>
                    </div>
                    {r.type === 'number' && (
                      <>
                        <div className="w-20"><Label htmlFor={`mn${i}`}>min</Label><Input id={`mn${i}`} type="number" value={r.min ?? ''} onChange={(e) => setRow(i, { min: e.target.value })} /></div>
                        <div className="w-20"><Label htmlFor={`mx${i}`}>max</Label><Input id={`mx${i}`} type="number" value={r.max ?? ''} onChange={(e) => setRow(i, { max: e.target.value })} /></div>
                      </>
                    )}
                  </>
                )}
                <button type="button" className="text-[var(--color-danger)]" onClick={() => removeRow(i)}>remove</button>
              </div>
            ))}
            <Button type="button" variant="secondary" onClick={addRow}>+ Add parameter</Button>
          </fieldset>

          <div className="flex items-center gap-3">
            <Button type="button" variant="secondary" onClick={onValidate}>Validate (dry run)</Button>
            {dry?.ok && <span className="text-sm text-[var(--color-primary)]">✓ reconstructs OK</span>}
            {dry && !dry.ok && <span className="text-sm text-[var(--color-danger)]">✗ {dry.reason}</span>}
          </div>

          {error && <div className="text-sm text-[var(--color-danger)]">{error}</div>}
          {saved && <div className="text-sm text-[var(--color-primary)]">Template saved.</div>}
          {canWrite && <div><Button type="submit">Save template</Button></div>}
        </form>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify `Button` supports a `variant` prop; if not, drop the props**

Run: `grep -n "variant" apps/control-plane/src/components/ui/button.tsx`
- If `variant` is a supported prop, keep as written.
- If NOT supported, remove every `variant="secondary"` from the file (plain buttons are fine — this is a functional editor, not a design task).

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @metamodels/control-plane exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Build the route**

Run: `pnpm --filter @metamodels/control-plane build`
Expected: build succeeds and the route list includes `/paddocks/[id]/templates`.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/app/\(app\)/paddocks/\[id\]/templates/templates-client.tsx
git commit -m "feat(control-plane): screen 8b — paste-graph → bind-params → dry-run template editor"
```

---

## Task 8: Wire navigation, docs, and whole-suite green

**Files:**
- Modify: `apps/control-plane/src/app/(app)/paddocks/[id]/fence/fence-client.tsx` *(link already added in Task 5 — verify only)*
- Modify: the paddocks list UI — `apps/control-plane/src/app/(app)/paddocks/paddocks-client.tsx` (add a "Templates" link on comfyui paddock rows)
- Modify: `apps/control-plane/README.md`

**Interfaces:**
- Consumes: nothing new.
- Produces: a discoverable entry point to `/paddocks/[id]/templates` for comfyui paddocks.

- [ ] **Step 1: Inspect the paddocks list to find where per-row links render**

Run: `grep -n "breed\|href\|fence\|Link\|flockId" apps/control-plane/src/app/\(app\)/paddocks/paddocks-client.tsx`
Note whether the row already knows each paddock's breed (it may only have `flockId`). If breed is not available on the client, add it to the props the page passes (mirror how the fence page derives breed from `listFlocks`). Keep the change minimal.

- [ ] **Step 2: Add the Templates link for comfyui rows**

Add, next to the existing "Fence" link for each paddock row, a conditional link shown only when the paddock's breed is `comfyui`:

```tsx
{breedOf(p) === 'comfyui' && (
  <Link href={`/paddocks/${p.id}/templates`} className="text-sm text-[var(--color-primary)] hover:underline">Templates</Link>
)}
```

Where `breedOf` resolves the row's breed from whatever breed/flock data the client already receives (add it to props if needed, per Step 1). If the paddocks list does not currently carry breed and threading it through is more than a couple of lines, instead render the Templates link **unconditionally** next to Fence — the target page itself `notFound()`s non-comfyui paddocks, so an Ollama row's link is harmless. Choose the smaller change and note which you chose in the commit message.

- [ ] **Step 3: Update the README Screens section**

In `apps/control-plane/README.md`, under `## Screens`, add a line after the Fence editor entry:

```markdown
- **Templates** (`/paddocks/[id]/templates`) — ComfyUI only: paste a workflow-API graph, bind typed params (text/seed/number/image) to node inputs, set cost, and dry-run `reconstructGraph` before saving into the Fence's `constraint_json.templates`.
```

And update the Fence editor line to drop "(coming in Plan 5.3)" phrasing if present.

- [ ] **Step 4: Typecheck + build**

Run: `pnpm --filter @metamodels/control-plane exec tsc --noEmit && pnpm --filter @metamodels/control-plane build`
Expected: clean typecheck; build lists both `/paddocks/[id]/fence` and `/paddocks/[id]/templates`.

- [ ] **Step 5: Run both test lanes + workspace typecheck**

Run:
```bash
pnpm --filter @metamodels/control-plane exec vitest run
pnpm test
pnpm -w exec tsc -b
```
Expected: control-plane suite green (55 prior + the new template/service/fence tests); root 166 pass / 3 skip; `tsc -b` clean.

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane/src/app/\(app\)/paddocks/paddocks-client.tsx apps/control-plane/README.md
git commit -m "feat(control-plane): link Templates screen from paddocks; document screen 8b"
```

---

## Self-Review (author checklist — completed at write time)

**Spec coverage:**
- Paste-graph → bind-params → dry-run authoring model → Tasks 1–3 (schema/parse/build/dry-run) + Task 7 (UI). ✓
- Output = `fence.constraint_json.templates: WorkflowTemplate[]` via existing persistence → Task 4 (`writeTemplates` uses `comfyuiConstraint`; reuses `saveFence`'s fence row). ✓
- Security invariants (unknown key rejected, seed server-generated, image upload-slot) → Task 3 invariant tests run the real `reconstructGraph`. ✓
- Replace the 9c hidden-field round-trip → Task 5 (preserve-on-omit `saveFence`; link instead of hidden field). ✓
- "Manage templates server-side rather than round-tripping through the client" (carry-forward) → Tasks 4 + 5. ✓
- Org isolation + comfyui-only + capability + tx+audit template → Task 4. ✓

**Placeholder scan:** No TBD/TODO; every code step is complete. Task 7 Step 2 and Task 8 Step 2 contain *explicit conditional instructions* (verify a prop / choose the smaller wiring change), not placeholders — each names the exact fallback.

**Type consistency:** `BuildResult<T>`, `TemplateDraft`, `validateDraft`, `parseGraphText`, `graphTargets`, `buildTemplate`, `dryRunTemplate`, `saveTemplate`, `deleteTemplate`, `listTemplates`, `paddockBreedInOrg`, `saveTemplateAction`/`deleteTemplateAction`/`dryRunTemplateAction`, `TemplatesClient` — names are used identically across the tasks that define and consume them. `ParamSpec`/`WorkflowTemplate`/`comfyuiConstraint`/`reconstructGraph` are imported from `@metamodels/connectors`, never re-declared.

**No new migration / dependency:** confirmed — templates live in existing `fence.constraint_json`; no package added.
