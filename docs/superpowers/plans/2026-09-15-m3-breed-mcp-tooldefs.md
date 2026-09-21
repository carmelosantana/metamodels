# M3 — Breed prep: typed MCP tool definitions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. **Every subagent is Opus — implementer, fixer, task reviewer and whole-branch reviewer. Never Haiku, never Sonnet. Pass `model: "opus"` explicitly on every dispatch.** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the dormant `toMcp?(fence: C): unknown[]` hook into a typed `McpToolDef[]` contract and implement it for both breeds, so M4's MCP endpoint only has to serve what the breeds already describe.

**Architecture:** `toMcp` stays a pure function of the fence (spec §4.4 as amended — templates already travel inside the ComfyUI fence). A new `packages/connectors/src/mcp.ts` defines `McpToolDef` per the MCP `2026-07-28` tools specification, plus `toolDefProblems()`, a validator every breed's output must pass. Ollama derives `chat`/`generate`/`embed`/`list_models` from `allowedRoutes` and `allowedModels`; ComfyUI derives one `run_<template>` tool per embedded template plus `get_job_result`. Nothing is served yet — M4 does that.

**Tech Stack:** TypeScript (ESM), vitest. **Zero new dependencies** — input schemas are hand-built JSON Schema literals, not generated.

**Spec:** [`docs/superpowers/specs/2026-09-06-remote-control-surface-design.md`](../specs/2026-09-06-remote-control-surface-design.md) — read §1 ("MCP specification baseline"), §4.4, §4.5 and §7.

## Global Constraints

- **The signature stays `toMcp?(fence: C)`.** Operator decision, 2026-09-15 (spec §2 C6, amended). Only the return type changes.
- **Zero new dependencies.** No MCP SDK, no zod-to-JSON-Schema.
- **A `mutate` route never becomes a tool.** Product guarantee (spec §5).
- **Tool names match `^[A-Za-z0-9_.-]{1,128}$`**, are unique within a paddock, and are returned **sorted by name** (MCP `2026-07-28`: deterministic order enables client and prompt caching).
- **Every `inputSchema` is `type: "object"`** with `additionalProperties: false`, and every `required` entry names a declared property.
- **Annotations are hints, never policy.** Clients MUST treat them as untrusted; enforcement stays in `guard()` and `reconstructGraph()`.
- **`toMcp` is pure:** no I/O, no mutation of the fence, same output for the same fence.
- **Independent of M1.** Touches only `packages/connectors`; may run in parallel with the M1 plan.
- **Commits** are authored `Carmelo Santana <me@carmelosantana.com>`, conventional-commit style, no attribution trailers. `main` is protected — land by PR.
- **Commands:** tests `pnpm exec vitest run packages/connectors`; type-check `pnpm exec tsc -b packages/connectors`; before the PR, the full `pnpm test`.

## File map

| File | Responsibility |
|---|---|
| `packages/connectors/src/mcp.ts` | `McpToolDef` and friends; `toolDefProblems()` |
| `packages/connectors/src/breed.ts` | `toMcp?(fence: C): McpToolDef[]` |
| `packages/connectors/src/ollama/mcp.ts` | Ollama's fence → tools |
| `packages/connectors/src/comfyui/mcp.ts` | ComfyUI's fence → tools, and the tool-name ↔ template-id mapping M4 needs |
| `packages/connectors/test/mcp.test.ts` | Validator tests |
| `packages/connectors/test/ollama-mcp.test.ts` | Ollama tool derivation |
| `packages/connectors/test/comfyui-mcp.test.ts` | ComfyUI tool derivation |

---

### Task 1: The `McpToolDef` contract and its validator

**Files:**
- Create: `packages/connectors/src/mcp.ts`
- Create: `packages/connectors/test/mcp.test.ts`
- Modify: `packages/connectors/src/breed.ts` (import + line 107)
- Modify: `packages/connectors/src/index.ts`

**Interfaces:**
- Produces (all exported from `@metamodels/connectors`):
  - `type JsonSchema = { [keyword: string]: unknown }`
  - `type JsonSchemaObject = JsonSchema & { type: 'object'; properties?: Record<string, JsonSchema>; required?: string[]; additionalProperties?: boolean }`
  - `interface McpToolAnnotations { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean }`
  - `interface McpToolDef { name: string; title?: string; description: string; inputSchema: JsonSchemaObject; annotations?: McpToolAnnotations }`
  - `MCP_TOOL_NAME: RegExp`
  - `byToolName(a: McpToolDef, b: McpToolDef): number` — the comparator every breed sorts with
  - `toolDefProblems(defs: readonly McpToolDef[]): string[]` — empty means valid
  - `Breed<C>.toMcp?(fence: C): McpToolDef[]`

- [ ] **Step 1: Write the failing test**

Create `packages/connectors/test/mcp.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { byToolName, toolDefProblems, type McpToolDef } from '../src/mcp.js'

function tool(name: string, over: Partial<McpToolDef> = {}): McpToolDef {
  return {
    name,
    description: `The ${name} tool.`,
    inputSchema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'], additionalProperties: false },
    ...over,
  }
}

describe('toolDefProblems', () => {
  test('accepts a valid, sorted set', () => {
    expect(toolDefProblems([tool('a.b'), tool('chat'), tool('run_x-1')])).toEqual([])
    expect(toolDefProblems([])).toEqual([])
  })

  test('rejects names outside the MCP character set or length', () => {
    expect(toolDefProblems([tool('has space')])).toEqual(['tool 0: invalid name "has space"'])
    expect(toolDefProblems([tool('x'.repeat(129))])[0]).toMatch(/^tool 0: invalid name/)
    expect(toolDefProblems([tool('')])[0]).toMatch(/^tool 0: invalid name/)
  })

  test('rejects duplicates and unsorted output', () => {
    expect(toolDefProblems([tool('a'), tool('a')])).toContain('tool 1: duplicate name a')
    expect(toolDefProblems([tool('b'), tool('a')])).toContain('tools must be sorted by name: "b" before "a"')
  })

  test('rejects an empty description', () => {
    expect(toolDefProblems([tool('a', { description: '  ' })])).toEqual(['a: empty description'])
  })

  test('rejects a non-object input schema', () => {
    const bad = tool('a', { inputSchema: { type: 'string' } as unknown as McpToolDef['inputSchema'] })
    expect(toolDefProblems([bad])).toContain('a: inputSchema.type must be "object"')
  })

  test('rejects a required property that is not declared', () => {
    const bad = tool('a', { inputSchema: { type: 'object', properties: {}, required: ['ghost'], additionalProperties: false } })
    expect(toolDefProblems([bad])).toEqual(['a: required "ghost" is not a declared property'])
  })

  test('rejects an input schema that allows undeclared properties', () => {
    const loose = tool('a', { inputSchema: { type: 'object', properties: {} } })
    expect(toolDefProblems([loose])).toEqual(['a: inputSchema must set additionalProperties: false'])
  })
})

describe('byToolName', () => {
  test('sorts in code-unit order, the order toolDefProblems checks', () => {
    const sorted = [tool('b'), tool('a'), tool('B'), tool('a.b')].sort(byToolName)
    expect(sorted.map((t) => t.name)).toEqual(['B', 'a', 'a.b', 'b'])
    expect(toolDefProblems(sorted)).toEqual([])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run packages/connectors/test/mcp.test.ts`
Expected: FAIL — `../src/mcp.js` cannot be resolved.

- [ ] **Step 3: Implement the contract**

Create `packages/connectors/src/mcp.ts`:

```ts
/**
 * MCP tool definitions, per the MCP specification revision 2026-07-28 (server/tools).
 *
 * A breed's `toMcp(fence)` returns these; M4's per-paddock endpoint serves them from `tools/list`.
 * `annotations` are hints for clients and are never read for enforcement: the spec requires
 * clients to treat them as untrusted, and MetaModels enforces in `guard()` / `reconstructGraph()`.
 */

export type JsonSchema = { [keyword: string]: unknown }

export type JsonSchemaObject = JsonSchema & {
  type: 'object'
  properties?: Record<string, JsonSchema>
  required?: string[]
  additionalProperties?: boolean
}

export interface McpToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface McpToolDef {
  name: string
  title?: string
  description: string
  inputSchema: JsonSchemaObject
  annotations?: McpToolAnnotations
}

/** The spec says tool names SHOULD be 1–128 of [A-Za-z0-9_.-]. MetaModels treats that as MUST. */
export const MCP_TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/

/** Sort comparator for tool lists: plain code-unit order, deterministic and locale-independent. */
export function byToolName(a: McpToolDef, b: McpToolDef): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

/**
 * Every invariant a breed's toMcp output must hold, as human-readable problems (empty = valid).
 * Order is plain code-unit order — deterministic and locale-independent.
 */
export function toolDefProblems(defs: readonly McpToolDef[]): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  defs.forEach((def, i) => {
    if (!MCP_TOOL_NAME.test(def.name)) problems.push(`tool ${i}: invalid name ${JSON.stringify(def.name)}`)
    if (seen.has(def.name)) problems.push(`tool ${i}: duplicate name ${def.name}`)
    else if (i > 0 && !(defs[i - 1].name < def.name)) {
      problems.push(`tools must be sorted by name: ${JSON.stringify(defs[i - 1].name)} before ${JSON.stringify(def.name)}`)
    }
    seen.add(def.name)

    if (!def.description.trim()) problems.push(`${def.name}: empty description`)
    const schema = def.inputSchema
    if (schema?.type !== 'object') {
      problems.push(`${def.name}: inputSchema.type must be "object"`)
      return
    }
    if (schema.additionalProperties !== false) problems.push(`${def.name}: inputSchema must set additionalProperties: false`)
    for (const r of schema.required ?? []) {
      if (!schema.properties || !Object.hasOwn(schema.properties, r)) {
        problems.push(`${def.name}: required ${JSON.stringify(r)} is not a declared property`)
      }
    }
  })
  return problems
}
```

In `packages/connectors/src/breed.ts`, add at the top:

```ts
import type { McpToolDef } from './mcp.js'
```

and replace line 107, `  toMcp?(fence: C): unknown[]`, with:

```ts
  /**
   * Derive this paddock's MCP tools from its fence (spec §4.4). Pure and deterministic: sorted by
   * name, valid per `toolDefProblems`, and never a tool for a `mutate` route.
   */
  toMcp?(fence: C): McpToolDef[]
```

In `packages/connectors/src/index.ts`, add after `export * from './breed.js'`:

```ts
export * from './mcp.js'
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/connectors`
Expected: PASS — 8 new tests (7 `toolDefProblems`, 1 `byToolName`), and every existing connectors suite unchanged (nothing implements `toMcp` yet, so the narrowed return type breaks nothing).

- [ ] **Step 5: Type-check and commit**

Run: `pnpm exec tsc -b packages/connectors apps/data-plane`
Expected: exit 0 — the data plane consumes the `Breed` type, so it proves the contract change is compatible.

```bash
git add packages/connectors/src/mcp.ts packages/connectors/src/breed.ts packages/connectors/src/index.ts packages/connectors/test/mcp.test.ts
git commit -m "feat(connectors): type toMcp as McpToolDef[] with a shared validator"
```

---

### Task 2: Ollama — derive tools from the fence

**Files:**
- Create: `packages/connectors/src/ollama/mcp.ts`
- Create: `packages/connectors/test/ollama-mcp.test.ts`
- Modify: `packages/connectors/src/ollama/breed.ts` (import + one `toMcp` line)
- Modify: `packages/connectors/src/ollama/index.ts`

**Interfaces:**
- Consumes: `McpToolDef`, `JsonSchema`, `byToolName`, `toolDefProblems` (Task 1); `OllamaConstraint = { allowedRoutes: ('chat'|'generate'|'embed'|'read')[]; allowedModels: string[] | null }`
- Produces: `ollamaToMcp(fence: OllamaConstraint): McpToolDef[]`, wired as `ollamaBreed.toMcp`

| Fence route group | Tool | Required input |
|---|---|---|
| `chat` | `chat` | `model`, `messages` |
| `generate` | `generate` | `model`, `prompt` (optional `system`) |
| `embed` | `embed` | `model`, `input` (non-empty string array) |
| `read` | `list_models` | — |
| `mutate` | *(never — the constraint schema cannot even express it)* | |

`allowedModels: null` → `model` is a free non-empty string. A list → a sorted, de-duplicated `enum`. `[]` → no inference tool at all (a tool that can only ever 403 is noise).

- [ ] **Step 1: Write the failing test**

Create `packages/connectors/test/ollama-mcp.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { ollamaBreed, ollamaConstraint, ollamaToMcp, toolDefProblems, type OllamaConstraint } from '../src/index.js'

const fence = (raw: unknown): OllamaConstraint => ollamaConstraint.parse(raw)
const names = (f: OllamaConstraint) => ollamaToMcp(f).map((t) => t.name)
const ALL = ['chat', 'generate', 'embed', 'read']

describe('ollamaToMcp', () => {
  test('the default fence exposes chat with a free-form model', () => {
    const tools = ollamaToMcp(fence({}))
    expect(tools.map((t) => t.name)).toEqual(['chat'])
    expect(tools[0].inputSchema.properties?.model).toEqual({ type: 'string', minLength: 1, description: expect.any(String) })
    expect(tools[0].inputSchema.required).toEqual(['model', 'messages'])
    expect(toolDefProblems(tools)).toEqual([])
  })

  test('one tool per allowed route group, sorted by name', () => {
    const f = fence({ allowedRoutes: ['read', 'generate', 'embed', 'chat'] })
    expect(names(f)).toEqual(['chat', 'embed', 'generate', 'list_models'])
    expect(toolDefProblems(ollamaToMcp(f))).toEqual([])
  })

  test('a model allowlist becomes a sorted, de-duplicated enum on every inference tool', () => {
    const f = fence({ allowedRoutes: ['chat', 'generate', 'embed'], allowedModels: ['qwen3:8b', 'llama3.2', 'qwen3:8b'] })
    const tools = ollamaToMcp(f)
    expect(tools).toHaveLength(3)
    for (const t of tools) expect(t.inputSchema.properties?.model).toMatchObject({ type: 'string', enum: ['llama3.2', 'qwen3:8b'] })
  })

  test('an empty allowlist leaves no inference tool', () => {
    expect(names(fence({ allowedRoutes: ['chat', 'read'], allowedModels: [] }))).toEqual(['list_models'])
    expect(names(fence({ allowedRoutes: ['chat'], allowedModels: [] }))).toEqual([])
  })

  test('never a model-management tool, and a fence cannot ask for one', () => {
    for (const n of names(fence({ allowedRoutes: ALL }))) expect(n).not.toMatch(/pull|push|create|copy|delete|blob/)
    expect(ollamaConstraint.safeParse({ allowedRoutes: ['mutate'] }).success).toBe(false)
  })

  test('every tool is annotated read-only and closed-world', () => {
    for (const t of ollamaToMcp(fence({ allowedRoutes: ALL }))) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false })
    }
  })

  test('pure: a frozen fence is not mutated and the output is stable', () => {
    const f = fence({ allowedRoutes: ['read', 'chat'], allowedModels: ['b', 'a'] })
    Object.freeze(f.allowedRoutes)
    Object.freeze(f.allowedModels)
    Object.freeze(f)
    expect(ollamaToMcp(f)).toEqual(ollamaToMcp(f))
    expect(f.allowedModels).toEqual(['b', 'a'])
  })

  test('is wired into the breed', () => {
    expect(ollamaBreed.toMcp).toBe(ollamaToMcp)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run packages/connectors/test/ollama-mcp.test.ts`
Expected: FAIL — `ollamaToMcp` is not exported from `../src/index.js`.

- [ ] **Step 3: Implement**

Create `packages/connectors/src/ollama/mcp.ts`:

```ts
import { byToolName, type JsonSchema, type McpToolAnnotations, type McpToolDef } from '../mcp.js'
import type { OllamaConstraint } from './constraint.js'

// Inference reads a model and changes nothing on the flock. Hints only — guard() enforces.
const INFERENCE: McpToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }
const LISTING: McpToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }

/** A fresh object per call: tools must not share (and so co-mutate) schema nodes. */
function modelSchema(allowed: readonly string[] | null): JsonSchema {
  if (allowed === null) {
    return { type: 'string', minLength: 1, description: 'Name of an Ollama model available on this paddock.' }
  }
  return { type: 'string', enum: [...new Set(allowed)].sort(), description: 'One of the models this paddock allows.' }
}

function chatTool(allowed: readonly string[] | null): McpToolDef {
  return {
    name: 'chat',
    title: 'Chat',
    description: 'Send a conversation to a model and get the next assistant message.',
    inputSchema: {
      type: 'object',
      properties: {
        model: modelSchema(allowed),
        messages: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', enum: ['system', 'user', 'assistant'] },
              content: { type: 'string' },
            },
            required: ['role', 'content'],
            additionalProperties: false,
          },
        },
      },
      required: ['model', 'messages'],
      additionalProperties: false,
    },
    annotations: INFERENCE,
  }
}

function generateTool(allowed: readonly string[] | null): McpToolDef {
  return {
    name: 'generate',
    title: 'Generate text',
    description: 'Complete a single prompt with a model.',
    inputSchema: {
      type: 'object',
      properties: {
        model: modelSchema(allowed),
        prompt: { type: 'string' },
        system: { type: 'string', description: 'Optional system prompt.' },
      },
      required: ['model', 'prompt'],
      additionalProperties: false,
    },
    annotations: INFERENCE,
  }
}

function embedTool(allowed: readonly string[] | null): McpToolDef {
  return {
    name: 'embed',
    title: 'Embed text',
    description: 'Compute embedding vectors for one or more strings.',
    inputSchema: {
      type: 'object',
      properties: {
        model: modelSchema(allowed),
        input: { type: 'array', minItems: 1, items: { type: 'string' } },
      },
      required: ['model', 'input'],
      additionalProperties: false,
    },
    annotations: INFERENCE,
  }
}

function listModelsTool(): McpToolDef {
  return {
    name: 'list_models',
    title: 'List models',
    description: 'List the models this paddock can use.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: LISTING,
  }
}

/**
 * Ollama's MCP tools for one paddock (spec §4.4). A pure projection of the fence: each allowed
 * route group becomes at most one tool. `mutate` is unreachable twice over — the constraint
 * schema cannot express it, and there is no branch here for it.
 */
export function ollamaToMcp(fence: OllamaConstraint): McpToolDef[] {
  const routes = new Set(fence.allowedRoutes)
  const allowed = fence.allowedModels
  const canInfer = allowed === null || allowed.length > 0
  const tools: McpToolDef[] = []
  if (canInfer && routes.has('chat')) tools.push(chatTool(allowed))
  if (canInfer && routes.has('generate')) tools.push(generateTool(allowed))
  if (canInfer && routes.has('embed')) tools.push(embedTool(allowed))
  if (routes.has('read')) tools.push(listModelsTool())
  return tools.sort(byToolName)
}
```

In `packages/connectors/src/ollama/breed.ts`, add `import { ollamaToMcp } from './mcp.js'` below the existing imports, and add one line after `billingDimensions: ['tokens_in', 'tokens_out'],`:

```ts
  toMcp: ollamaToMcp,
```

In `packages/connectors/src/ollama/index.ts`, add:

```ts
export { ollamaToMcp } from './mcp.js'
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/connectors`
Expected: PASS — 8 new `ollamaToMcp` tests; every existing connectors suite unchanged.

- [ ] **Step 5: Type-check and commit**

Run: `pnpm exec tsc -b packages/connectors`
Expected: exit 0.

```bash
git add packages/connectors/src/ollama packages/connectors/test/ollama-mcp.test.ts
git commit -m "feat(connectors): derive Ollama MCP tools from the paddock fence"
```

---

### Task 3: ComfyUI — one tool per approved template

**Files:**
- Create: `packages/connectors/src/comfyui/mcp.ts`
- Create: `packages/connectors/test/comfyui-mcp.test.ts`
- Modify: `packages/connectors/src/comfyui/breed.ts` (import + one `toMcp` line)
- Modify: `packages/connectors/src/comfyui/index.ts`

**Interfaces:**
- Consumes: `McpToolDef`, `JsonSchema`, `byToolName`, `MCP_TOOL_NAME`, `toolDefProblems` (Task 1); `ComfyConstraint = { templates: WorkflowTemplate[] }`; `ParamSpec`, `WorkflowTemplate` (existing, `comfyui/template.ts`)
- Produces (exported from `@metamodels/connectors`):
  - `JOB_RESULT_TOOL = 'get_job_result'`
  - `comfyToolName(templateId: string): string` — `run_` + the id with every character outside `[A-Za-z0-9_.-]` replaced by `_`, capped at 128
  - `comfyToolNames(templates: readonly Pick<WorkflowTemplate, 'id'>[]): Map<string, string>` — tool name → template id, collisions suffixed `_2`, `_3`… in template order. **M4's `tools/call` uses this map to turn `run_x` back into `{ template_id }` for `comfyuiBreed.handle`.**
  - `comfyToMcp(fence: ComfyConstraint): McpToolDef[]`, wired as `comfyuiBreed.toMcp`

| `ParamSpec.type` | Input schema | Why |
|---|---|---|
| `text` | `{ type: 'string' }` | `reconstructGraph` requires a string |
| `number` | `{ type: 'number', minimum?, maximum? }` | mirrors the spec's `min`/`max` |
| `image` | `{ type: 'string', contentEncoding: 'base64' }` | `handle` uploads the base64 itself |
| `seed` | *(omitted)* | `reconstructGraph` randomises seeds on every run; a caller value would be ignored |

No property is `required`: `reconstructGraph` leaves an unsupplied param at the template's own value.

- [ ] **Step 1: Write the failing test**

Create `packages/connectors/test/comfyui-mcp.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import {
  comfyToMcp, comfyToolName, comfyToolNames, comfyuiBreed, comfyuiConstraint, toolDefProblems,
  type WorkflowTemplate,
} from '../src/index.js'

function tpl(id: string, params: WorkflowTemplate['params'] = [], cost = 1): WorkflowTemplate {
  return { id, graph: { '1': { class_type: 'KSampler', inputs: {} } }, params, cost }
}

const txt2img = tpl('txt2img', [
  { name: 'prompt', type: 'text', target: { node: '1', input: 'text' } },
  { name: 'steps', type: 'number', target: { node: '1', input: 'steps' }, min: 1, max: 50 },
  { name: 'seed', type: 'seed', targets: [{ node: '1', input: 'seed' }] },
  { name: 'init', type: 'image', target: { node: '1', input: 'image' } },
], 2)

describe('comfyToolName', () => {
  test('prefixes and sanitises the template id', () => {
    expect(comfyToolName('txt2img')).toBe('run_txt2img')
    expect(comfyToolName('sdxl turbo/v2')).toBe('run_sdxl_turbo_v2')
    expect(comfyToolName('')).toBe('run__')
  })

  test('caps the name at 128 characters', () => {
    expect(comfyToolName('x'.repeat(300))).toHaveLength(128)
  })
})

describe('comfyToolNames', () => {
  test('suffixes collisions in template order and maps each name back to its id', () => {
    expect([...comfyToolNames([tpl('a b'), tpl('a_b'), tpl('a/b')])]).toEqual([
      ['run_a_b', 'a b'], ['run_a_b_2', 'a_b'], ['run_a_b_3', 'a/b'],
    ])
  })

  test('a duplicate template id gets no second tool (submit resolves the first)', () => {
    expect([...comfyToolNames([tpl('dup'), tpl('dup')])]).toEqual([['run_dup', 'dup']])
  })

  test('suffixed names still fit in 128 characters', () => {
    const long = 'y'.repeat(200)
    const got = [...comfyToolNames([tpl(long), tpl(`${long}!`)]).keys()]
    expect(got.map((n) => n.length)).toEqual([128, 128])
    expect(got[1].endsWith('_2')).toBe(true)
  })
})

describe('comfyToMcp', () => {
  test('no templates, no tools', () => {
    expect(comfyToMcp(comfyuiConstraint.parse({}))).toEqual([])
  })

  test('one run tool per template plus get_job_result, sorted and valid', () => {
    const tools = comfyToMcp({ templates: [tpl('upscale'), txt2img] })
    expect(tools.map((t) => t.name)).toEqual(['get_job_result', 'run_txt2img', 'run_upscale'])
    expect(toolDefProblems(tools)).toEqual([])
    const upscale = tools.find((t) => t.name === 'run_upscale')!
    expect(upscale.description).toContain('1 job unit.')
    expect(upscale.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false })
  })

  test('params map to JSON Schema, and seeds are never caller inputs', () => {
    const run = comfyToMcp({ templates: [txt2img] }).find((t) => t.name === 'run_txt2img')!
    expect(run.inputSchema).toEqual({
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        steps: { type: 'number', minimum: 1, maximum: 50 },
        init: { type: 'string', contentEncoding: 'base64', description: 'Base64-encoded image bytes.' },
      },
      additionalProperties: false,
    })
    expect(run.description).toContain('2 job units.')
  })

  test('get_job_result takes exactly a job_id', () => {
    const get = comfyToMcp({ templates: [txt2img] }).find((t) => t.name === 'get_job_result')!
    expect(get.inputSchema).toEqual({
      type: 'object', properties: { job_id: { type: 'string', minLength: 1 } }, required: ['job_id'], additionalProperties: false,
    })
    expect(get.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true })
  })

  test('a param named __proto__ becomes an own property, not a prototype', () => {
    const odd = tpl('odd', [{ name: '__proto__', type: 'text', target: { node: '1', input: 'text' } }])
    const props = comfyToMcp({ templates: [odd] }).find((t) => t.name === 'run_odd')!.inputSchema.properties!
    expect(Object.getOwnPropertyDescriptor(props, '__proto__')?.value).toEqual({ type: 'string' })
    expect(Object.getPrototypeOf(props)).toBe(Object.prototype)
  })

  test('pure, and wired into the breed', () => {
    const fence = { templates: [txt2img] }
    const before = structuredClone(fence)
    expect(comfyToMcp(fence)).toEqual(comfyToMcp(fence))
    expect(fence).toEqual(before)
    expect(comfyuiBreed.toMcp).toBe(comfyToMcp)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run packages/connectors/test/comfyui-mcp.test.ts`
Expected: FAIL — `comfyToMcp`, `comfyToolName` and `comfyToolNames` are not exported from `../src/index.js`.

- [ ] **Step 3: Implement**

Create `packages/connectors/src/comfyui/mcp.ts`:

```ts
import { byToolName, type JsonSchema, type McpToolDef } from '../mcp.js'
import type { ComfyConstraint } from './breed.js'
import type { ParamSpec, WorkflowTemplate } from './template.js'

export const JOB_RESULT_TOOL = 'get_job_result'
const PREFIX = 'run_'
const MAX_NAME = 128

/** `run_` + the template id, made safe for MCP's tool-name charset and length. */
export function comfyToolName(templateId: string): string {
  const safe = templateId.replace(/[^A-Za-z0-9_.-]/g, '_') || '_'
  return `${PREFIX}${safe}`.slice(0, MAX_NAME)
}

/**
 * Tool name → template id for every reachable template, in template order. Sanitising can make
 * two ids collide (`a b`, `a_b`); later ones get `_2`, `_3`… A repeated id is skipped: the
 * submit flow resolves the first template with that id, so a second tool could never reach its
 * own template. M4 inverts tool calls through this map — never by un-sanitising a name.
 */
export function comfyToolNames(templates: readonly Pick<WorkflowTemplate, 'id'>[]): Map<string, string> {
  const names = new Map<string, string>()
  const seen = new Set<string>()
  for (const { id } of templates) {
    if (seen.has(id)) continue
    seen.add(id)
    const base = comfyToolName(id)
    let name = base
    for (let n = 2; names.has(name); n++) {
      const suffix = `_${n}`
      name = base.slice(0, MAX_NAME - suffix.length) + suffix
    }
    names.set(name, id)
  }
  return names
}

function paramSchema(spec: Exclude<ParamSpec, { type: 'seed' }>): JsonSchema {
  switch (spec.type) {
    case 'text':
      return { type: 'string' }
    case 'number': {
      const s: JsonSchema = { type: 'number' }
      if (spec.min !== undefined) s.minimum = spec.min
      if (spec.max !== undefined) s.maximum = spec.max
      return s
    }
    case 'image':
      return { type: 'string', contentEncoding: 'base64', description: 'Base64-encoded image bytes.' }
  }
}

function runTool(name: string, tpl: WorkflowTemplate): McpToolDef {
  // Seeds are randomised server-side on every run, so they are never a caller input.
  // Object.fromEntries defines own properties, so a param named "__proto__" stays data.
  const properties = Object.fromEntries(
    tpl.params.flatMap((spec) => (spec.type === 'seed' ? [] : [[spec.name, paramSchema(spec)] as const])),
  )
  const units = `${tpl.cost} job unit${tpl.cost === 1 ? '' : 's'}`
  return {
    name,
    title: `Run ${tpl.id}`,
    description:
      `Run the operator-approved ComfyUI workflow "${tpl.id}". Every parameter is optional; an omitted one ` +
      `keeps the template's own value. Returns a job_id: pass it to ${JOB_RESULT_TOOL} for the output. ` +
      `Each run costs ${units}.`,
    inputSchema: { type: 'object', properties, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }
}

function jobResultTool(): McpToolDef {
  return {
    name: JOB_RESULT_TOOL,
    title: 'Get job result',
    description: "Fetch the status and outputs of a job started by one of this paddock's run_ tools. Only the caller's own jobs are visible.",
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string', minLength: 1 } },
      required: ['job_id'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }
}

/**
 * ComfyUI's MCP tools for one paddock (spec §4.4): one `run_<template>` per approved template,
 * plus `get_job_result` whenever there is anything to run. Raw graphs are no more reachable
 * through MCP than through REST — every tool funnels into `handle` → `reconstructGraph`.
 */
export function comfyToMcp(fence: ComfyConstraint): McpToolDef[] {
  const byId = new Map<string, WorkflowTemplate>()
  for (const t of fence.templates) if (!byId.has(t.id)) byId.set(t.id, t)
  const tools = [...comfyToolNames(fence.templates)].map(([name, id]) => runTool(name, byId.get(id)!))
  if (tools.length > 0) tools.push(jobResultTool())
  return tools.sort(byToolName)
}
```

`mcp.ts` only takes a **type** from `./breed.js`, so the new `breed.ts` → `mcp.ts` import below forms no runtime cycle.

In `packages/connectors/src/comfyui/breed.ts`, add `import { comfyToMcp } from './mcp.js'` below the `./template.js` imports, and add one line after `billingDimensions: ['jobs', 'gpu_ms', 'images'],`:

```ts
  toMcp: comfyToMcp,
```

In `packages/connectors/src/comfyui/index.ts`, add:

```ts
export { comfyToMcp, comfyToolName, comfyToolNames, JOB_RESULT_TOOL } from './mcp.js'
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/connectors`
Expected: PASS — 11 new ComfyUI tests, plus the Task 1 and Task 2 suites and every existing connectors suite.

- [ ] **Step 5: Run the whole repo and commit**

Run: `pnpm typecheck`
Expected: exit 0 across every project reference.

Run: `pnpm test`
Expected: PASS — every root-lane suite.

```bash
git add packages/connectors/src/comfyui packages/connectors/test/comfyui-mcp.test.ts
git commit -m "feat(connectors): derive ComfyUI MCP tools from approved templates"
```

---

## Handoff to M4

- `tools/list` for `/p/<slug>/mcp` = `breed.toMcp(fence)`, filtered by the caller's grants; M3 guarantees the list is valid, sorted and mutate-free before any filtering.
- `tools/call run_*` resolves the template id through `comfyToolNames(fence.templates)`, then calls `comfyuiBreed.handle` with `{ template_id, params: arguments }`. Never reverse the sanitisation.
- `tools/call get_job_result` reuses the data plane's existing key-scoped `/p/:slug/result/:jobId` logic, not a second implementation.
- Ollama `tools/call` maps `chat` → `POST /api/chat` and `generate` → `POST /api/generate` (both with `stream: false` — each streams NDJSON by default), `embed` → `POST /api/embed`, `list_models` → `GET /api/tags`, through the same `guard()` → proxy → `meter()` path as REST, so fence enforcement and metering stay single-sourced. **Build each upstream body only from the tool's declared `inputSchema` properties — never spread `arguments`.** `additionalProperties: false` binds clients only; `guard()` checks route group and model and forwards the rest verbatim (`keep_alive`, `options.num_ctx`, `stream` would all pass).
- `list_models` output is intersected with the fence's `allowedModels` (when non-null) before it is returned; `/api/tags` itself lists every model on the flock.
- `tools/call` may omit `arguments`: pass `arguments ?? {}` (ComfyUI's `submitBody` requires a `params` record, and would 422).
- Cap the request body size on `/p/<slug>/mcp`: `image` params are unbounded base64 strings, in MCP as in REST.
- ComfyUI tool names are stable only for one fence snapshot: resolve `tools/call` against the same fence `tools/list` was built from, and consider restricting template ids at save time to `^[A-Za-z0-9_.-]{1,124}$` (which makes names a bijection and removes the suffix scheme — needs a rule for existing ids).
