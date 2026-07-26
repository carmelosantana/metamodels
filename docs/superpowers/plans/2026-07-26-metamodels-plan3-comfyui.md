# MetaModels Plan 3 — ComfyUI Breed (templates, graph reconstruction, metering)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. **Execution config: `opus` (4.8) for BOTH implementer and reviewer subagents.** Steps use checkbox (`- [ ]`) tracking.

**Goal:** Add a ComfyUI connector so a consumer can run a pre-approved workflow **template** with a constrained set of param overrides — the raw node graph is reconstructed server-side (never accepted from the client) — and get a metered, scoped result, all behind the same auth/rate-limit plane as Ollama.

**Architecture:** ComfyUI's flow is two-phase and async (submit a node graph to `POST /prompt` → poll `GET /history/{prompt_id}` → fetch output image bytes), which does not fit the single-request `guard→proxy→meter` path Ollama uses. So Plan 3 (a) refactors the data path to be **content-type-agnostic** and moves metering extraction **into the breed**, then (b) adds an optional **`handle`** hook to the `Breed` contract for connectors that own their own multi-step flow, plus a **`JobStore`** for job ownership. Ollama keeps using the generic path (no `handle`); ComfyUI implements `handle`. Templates are the product unit; a consumer sends `{ template_id, params }` and the breed validates params against the template's `param_schema` and rebuilds the full graph.

**Tech Stack:** unchanged from Plan 2 (TypeScript, Hono, Drizzle, pglite tests, injected `fetchImpl`). No new runtime deps expected. Metering uses `/history` reconciliation (jobs / output-images / gpu_ms from history timing); live `/ws` progress relay is explicitly deferred.

## Global Constraints

_Every task's requirements implicitly include this section._

- **Branch:** `feat/metamodels-plan-3`; never commit to `main`. **Identity:** `Carmelo Santana <me@carmelosantana.com>`. **License:** AGPL-3.0.
- **Language:** TypeScript, **Node 24+** (LTS floor; `engines.node: ">=24"`, `.nvmrc` = 24), ESM (`"type":"module"`), `.js` import extensions, `verbatimModuleSyntax`. **pnpm** workspaces only.
- **Supply chain:** the repo `.npmrc` enforces `minimumReleaseAge=1440` (24h quarantine on newly-published packages) and `blockExoticSubdeps=true`. Plan 3 expects **no new dependencies**; if a task genuinely needs one, use a mature (>24h-old) version and flag it to the controller — a brand-new version will be quarantined by design. Never delete/regenerate the lockfile to "fix" an install; explain any lockfile diff.
- **ComfyUI security (non-negotiable):** the consumer NEVER submits raw node structure. Ingress is `{ template_id, params }` only. The breed reconstructs the full graph from the operator's stored template. Params are validated against the template's `param_schema`; any param not declared is rejected. `/view` and `/history` are NEVER exposed directly — the only result path is the scoped `result` route keyed to the caller's own job.
- **Job ownership:** every submitted job records `{ jobId(=prompt_id), keyId, paddockId, orgId, templateId, cost }`. A `result` request must verify the job belongs to the requesting key (else 404, not 403 — don't leak existence).
- **Metering:** meter `jobs` (+ template `cost` weight) once per job; meter `images` and `gpu_ms` from `/history` at completion; never double-count (guard with a `metered` flag on the job record). Meter records are `org_id`-scoped, keyed by key×paddock, dims from `breed.billingDimensions` = `['jobs','gpu_ms','images']`.
- **Refactor safety (Tasks 1–2):** the Ollama path and all 63 existing tests MUST stay green after the content-type-agnostic + metering-seam refactor. TDD; frequent commits; DRY; YAGNI.
- **Acceptance fixture:** the latex.pics `data/workflows/v0.3.2.json` (txt2img) must be wrappable as a template exposing `{prompt, seed}`; `v0.3.2-img.json` (img2img) additionally exposes an `image` param injected into its `LoadImage` node. (Do NOT copy that JSON into the repo — build equivalent fixtures inline in tests.)

---

## Architecture decisions (locked in this plan)

1. **`Breed.handle?` hook.** Extend the `Breed<C>` interface with an optional:
   ```ts
   handle?(ctx: RequestCtx, fence: C, io: BreedIO): Promise<BreedHandleResult>
   ```
   When present, the data-plane app — after auth, paddock resolution, scope check, and rate-limit — delegates the entire request to `breed.handle(...)` instead of running `guard→proxy→meter`. The breed owns its own upstream calls, metering, and response. Ollama does **not** define `handle` (unchanged). This keeps the generic path intact and lets ComfyUI own its two-phase flow without polluting the generic contract.
2. **`BreedIO`** (passed to `handle`) is the breed's capability surface, so the breed stays testable:
   ```ts
   interface BreedIO {
     ids: { orgId: string; keyId: string; paddockId: string }
     flock: FlockRef
     upstream(req: RewrittenRequest): Promise<UpstreamResult>   // JSON round-trip to the flock
     upstreamRaw(path: string, init: RequestInit): Promise<Response> // for uploads / binary fetch
     emitMeter(events: MeterEvent[]): Promise<void>
     jobs: JobStore
   }
   ```
3. **`JobStore`** interface + in-memory impl now; Postgres/Redis-backed later (Plan 4/5). Ownership + double-meter guard live here.
4. **Metering via `/history`** (jobs/images/gpu_ms), not live `/ws`. Progress streaming to the consumer is a deferred enhancement (noted at plan end).
5. **Images via base64 in JSON** for v1 (not multipart) — the content-type-agnostic refactor still applies (ComfyUI's own upstream `/upload/image` call is multipart, issued by the breed via `upstreamRaw`), but the consumer→MetaModels ingress stays JSON `{template_id, params}` with image params as base64 data. Multipart ingress is a later enhancement.

---

## File Structure

```
packages/connectors/src/
  breed.ts               # (modify) add handle?, BreedIO, BreedHandleResult, JobRecord types
  comfyui/
    template.ts          # WorkflowTemplate type, ParamSpec, param validation, graph reconstruction
    breed.ts             # comfyuiBreed: constraintSchema + handle (submit) + meterFromHistory helpers
    result.ts            # parse /history → { done, images[], gpuMs }
    index.ts
  comfyui/test in packages/connectors/test/
    comfyui-template.test.ts
    comfyui-handle.test.ts
    comfyui-result.test.ts

apps/data-plane/src/
  proxy/proxy.ts         # (modify Task 1) content-type-agnostic body + header passthrough
  meter/extract.ts       # (Task 2) generic extraction moved out of proxy — proxy no longer parses for meaning
  jobs/job-store.ts       # JobStore interface + InMemoryJobStore
  app.ts                 # (modify) delegate to breed.handle when defined; add result route
apps/data-plane/test/
  helpers/fake-comfyui.ts # Hono app simulating ComfyUI (/prompt, /history, /view, /upload/image)
  comfyui.integration.test.ts
```

---

### Task 1: Make the data path content-type-agnostic

**Goal:** the proxy/app stop assuming JSON so ComfyUI's binary/base64 flows fit. The app must not hardcode `content-type: application/json`; the proxy must pass a body through based on its actual type and not force JSON semantics on responses.

**Files:** Modify `apps/data-plane/src/proxy/proxy.ts`, `apps/data-plane/src/app.ts`. Test: extend `apps/data-plane/test/proxy.test.ts`.

**Interfaces:**
- Change `RewrittenRequest`-driven proxy so that when `req.body` is a `string`/`Uint8Array`/`ReadableStream` it is sent as-is (no `JSON.stringify`), and only a plain object is JSON-serialized. `content-type` comes from `req.headers`, not a hardcoded default.
- `app.ts`: forward the inbound `content-type` into `ctx.headers` rather than hardcoding `application/json`; only `JSON.parse` the body when the inbound `content-type` is JSON (else pass the raw text/bytes as `ctx.body`).

- [ ] **Step 1: Write the failing test** — add to `proxy.test.ts` a case where `req.body` is a pre-serialized `string` and assert the upstream receives it verbatim (not double-encoded). Add a case where `req.headers['content-type']` is `text/plain` and assert the proxy does not overwrite it with JSON.

```ts
test('sends a string body verbatim without JSON re-encoding', async () => {
  let seen: unknown
  const fetchImpl = async (_url: string, init: RequestInit) => { seen = init.body; return new Response('ok') }
  await proxyToUpstream({ baseUrl: 'http://u', upstreamAuth: null },
    { method: 'POST', path: '/x', headers: { 'content-type': 'text/plain' }, body: 'raw-body' },
    { fetchImpl })
  expect(seen).toBe('raw-body')
})
```

- [ ] **Step 2: Run to verify it fails** — `pnpm test proxy` → FAIL (current code `JSON.stringify`s the string to `'"raw-body"'`).

- [ ] **Step 3: Implement** — in `proxy.ts`, replace the body-serialization block:
```ts
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.body !== undefined) {
    if (typeof req.body === 'string' || req.body instanceof Uint8Array || req.body instanceof ReadableStream) {
      init.body = req.body as BodyInit
    } else {
      init.body = JSON.stringify(req.body)
      if (!headers['content-type']) headers['content-type'] = 'application/json'
    }
  }
```
In `app.ts`, replace the `ctx` construction so it reads the inbound content-type and only JSON-parses JSON:
```ts
    const contentType = c.req.header('content-type') ?? ''
    let body: unknown
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      body = contentType.includes('application/json')
        ? await c.req.json().catch(() => undefined)
        : await c.req.text().catch(() => undefined)
    }
    const ctx: RequestCtx = {
      method: c.req.method, path: upstreamPath,
      headers: contentType ? { 'content-type': contentType } : {},
      body, paddockSlug: slug,
    }
```

- [ ] **Step 4: Run** — `pnpm test proxy` then FULL `pnpm test`. Expected: new cases pass; all 63 prior tests still green (Ollama JSON path unaffected because plain objects still JSON-serialize and the Ollama guard sets JSON content-type).

- [ ] **Step 5: Commit** — `git commit -m "refactor(data-plane): content-type-agnostic proxy + app body handling"`

---

### Task 2: Move metering extraction into the breed seam

**Goal:** the proxy stops interpreting response bytes for *meaning*. Today `proxyToUpstream`'s `readOutcome` parses NDJSON/SSE to build `finalFrame`. That's fine for text APIs but wrong for ComfyUI (binary images, and metering comes from `/history`, not the response body). Keep the tee + final-frame capture as a **generic text convenience**, but make the app call `breed.meter(ctx, upstream)` as the single source of metering truth (it already does) and ensure the proxy exposes the raw `UpstreamResult` without assuming the body is meaningful JSON.

**Files:** Create `apps/data-plane/src/meter/extract.ts`. Modify `proxy.ts` to delegate final-frame parsing to a small exported `extractTextFrames(buffer)` helper (moved verbatim from `readOutcome`), so the parsing logic has one home and the ComfyUI breed can reuse or ignore it. Test: `apps/data-plane/test/extract.test.ts`.

**Interfaces:**
- `export function extractTextFrames(buffer: string): { body: unknown; finalFrame: unknown }` — the NDJSON/SSE/whole-JSON logic currently inside `readOutcome`, pulled out and unit-tested directly.
- `readOutcome` now calls `extractTextFrames`.

- [ ] **Step 1: Write the failing test** — `extract.test.ts` covering NDJSON (last frame), SSE (`data:` + `[DONE]`), and single-object cases against `extractTextFrames` directly (the same three shapes the proxy tests already cover, now unit-level).
- [ ] **Step 2: Run to verify fail** — `pnpm test extract` → FAIL (module missing).
- [ ] **Step 3: Implement** — move the parsing out of `readOutcome` into `extract.ts`; `readOutcome` imports and calls it. No behavior change.
- [ ] **Step 4: Run** — `pnpm test extract && pnpm test proxy && pnpm test` → all green (pure refactor; Ollama metering unchanged).
- [ ] **Step 5: Commit** — `git commit -m "refactor(data-plane): extract text-frame parsing into meter/extract"`

---

### Task 3: Extend the Breed contract (handle hook + types)

**Files:** Modify `packages/connectors/src/breed.ts`; create `packages/connectors/src/job.ts`. Test: `packages/connectors/test/breed-handle.test.ts`.

**Interfaces (added to `breed.ts`, all optional/additive — Ollama unaffected):**
```ts
export interface JobRecord {
  jobId: string; keyId: string; paddockId: string; orgId: string
  templateId: string; cost: number; metered: boolean; submittedAt: number
}
export interface JobStore {
  create(job: Omit<JobRecord, 'metered'>): Promise<JobRecord>
  get(jobId: string): Promise<JobRecord | null>
  markMetered(jobId: string): Promise<void>
}
export interface BreedIO {
  ids: { orgId: string; keyId: string; paddockId: string }
  flock: FlockRef
  upstream(req: RewrittenRequest): Promise<UpstreamResult>
  upstreamRaw(path: string, init: RequestInit): Promise<Response>
  emitMeter(events: MeterEvent[]): Promise<void>
  jobs: JobStore
}
export interface BreedHandleResult { status: number; body: unknown }
```
Add to `interface Breed<C>`:
```ts
  handle?(ctx: RequestCtx, fence: C, io: BreedIO): Promise<BreedHandleResult>
```

- [ ] **Step 1: Write the failing test** — a tiny fake breed defining `handle` that echoes `io.ids` and calls `io.emitMeter`; assert the contract shapes compile and the handle returns `{status, body}`. (Type-level + runtime smoke.)
- [ ] **Step 2: Run to verify fail** — `pnpm test breed-handle` → FAIL.
- [ ] **Step 3: Implement** the type additions in `breed.ts` and export `JobStore`/`JobRecord`/`BreedIO`/`BreedHandleResult`.
- [ ] **Step 4: Run** — `pnpm test breed-handle && pnpm test && pnpm typecheck` → all green (additive change; echo/ollama breeds unaffected).
- [ ] **Step 5: Commit** — `git commit -m "feat(connectors): optional Breed.handle hook + BreedIO/JobStore types"`

---

### Task 4: Workflow template model + graph reconstruction (the security heart)

**Files:** Create `packages/connectors/src/comfyui/template.ts`. Test: `packages/connectors/test/comfyui-template.test.ts`.

**Interfaces:**
```ts
export type ParamSpec =
  | { name: string; type: 'text'; target: { node: string; input: string } }
  | { name: string; type: 'seed'; targets: { node: string; input: string }[] }  // randomized/bounded
  | { name: string; type: 'number'; target: { node: string; input: string }; min?: number; max?: number }
  | { name: string; type: 'image'; target: { node: string; input: string } }     // base64 → uploaded filename
export interface WorkflowTemplate {
  id: string; graph: Record<string, { class_type: string; inputs: Record<string, unknown> }>
  params: ParamSpec[]; cost: number
}
// Validate + reconstruct. `uploads` maps an image param name → the filename returned by /upload/image.
// `rng` supplies deterministic seeds in tests.
export function reconstructGraph(
  tpl: WorkflowTemplate,
  params: Record<string, unknown>,
  opts: { uploads?: Record<string, string>; rng?: () => number },
): { ok: true; graph: WorkflowTemplate['graph'] } | { ok: false; reason: string }
```
Rules: every key in `params` must correspond to a declared `ParamSpec` (reject unknown params → `ok:false`). `text` writes a string to `graph[node].inputs[input]`. `number` validates min/max. `seed` writes `Math.floor((rng?.() ?? Math.random()) * 1e12)` to every listed target. `image` requires `uploads[name]` and writes that filename. The returned graph is a deep clone (never mutate the stored template).

- [ ] **Step 1: Write the failing test** — build a small inline graph mirroring latex.pics v0.3.2 shape (a `CLIPTextEncode`-like node for the prompt, a `KSampler` with a `seed`, a `LoadImage` for the image case). Assert: a declared `text` param lands in the right node input; an **undeclared** param is rejected; `seed` is randomized into the KSampler via injected `rng`; an `image` param requires an upload filename and injects it into LoadImage; the stored template object is not mutated.
- [ ] **Step 2: Run to verify fail** — `pnpm test comfyui-template` → FAIL.
- [ ] **Step 3: Implement** `template.ts` per the rules (deep clone via `structuredClone`).
- [ ] **Step 4: Run** — `pnpm test comfyui-template` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(connectors): comfyui template param validation + server-side graph reconstruction"`

---

### Task 5: Result parsing (/history → images + gpu_ms)

**Files:** Create `packages/connectors/src/comfyui/result.ts`. Test: `packages/connectors/test/comfyui-result.test.ts`.

**Interfaces:**
```ts
export interface JobOutcome { done: boolean; images: { filename: string; subfolder: string; type: string }[]; gpuMs: number }
export function parseHistory(history: unknown, promptId: string): JobOutcome
```
`parseHistory` reads `history[promptId]`: `status.completed === true` → `done`; collects every `outputs[nodeId].images[]` entry; `gpuMs` from `status.messages` execution_start→execution_success timestamps when present, else `0`. Missing/absent prompt → `{ done:false, images:[], gpuMs:0 }`.

- [ ] **Step 1: Write the failing test** — feed a fake `/history` object (a completed job with two output images and start/success timestamps) and assert `done`, two images, and a positive `gpuMs`; feed an empty history and assert not-done/empty.
- [ ] **Step 2–4:** RED → implement → GREEN (`pnpm test comfyui-result`).
- [ ] **Step 5: Commit** — `git commit -m "feat(connectors): comfyui /history result parsing (images + gpu_ms)"`

---

### Task 6: ComfyUI breed — constraint schema + `handle` (submit flow)

**Files:** Create `packages/connectors/src/comfyui/breed.ts`, `packages/connectors/src/comfyui/index.ts`; modify `packages/connectors/src/index.ts`. Test: `packages/connectors/test/comfyui-handle.test.ts`.

**Interfaces:**
- `comfyuiConstraint` (Zod): `{ templates: WorkflowTemplate[] }` (the Fence embeds the operator's approved templates for this Paddock).
- `comfyuiBreed: Breed<ComfyConstraint>` with `id:'comfyui'`, `billingDimensions: ['jobs','gpu_ms','images']`, a `guard` that hard-denies direct upstream routes (defense in depth — the app only calls `handle`, but `guard` must reject if ever reached), and `handle`:
  1. Parse `ctx.body` as `{ template_id, params }` (reject 422 if malformed).
  2. Find the template in `fence.templates`; reject 404 if unknown.
  3. For each `image` param: `io.upstreamRaw('/upload/image', multipart)` → filename; collect into `uploads`.
  4. `reconstructGraph(tpl, params, { uploads })`; reject 422 on `ok:false` with the reason.
  5. `io.upstream({ method:'POST', path:'/prompt', headers:{'content-type':'application/json'}, body:{ prompt: graph } })` → read `prompt_id`.
  6. `io.jobs.create({ jobId: prompt_id, ...io.ids, templateId, cost: tpl.cost, submittedAt: Date.now() })`.
  7. `io.emitMeter([{ dim:'jobs', value: tpl.cost, at: Date.now() }])`.
  8. Return `{ status: 202, body: { job_id: prompt_id } }`.

- [ ] **Step 1: Write the failing test** — using a fake `BreedIO` (stub `upstream` returning `{prompt_id:'p1'}`, stub `upstreamRaw` returning `{name:'up.png'}`, an in-memory `jobs`, a capturing `emitMeter`): assert a valid `{template_id,params}` reconstructs+submits, records the job with the right ids, emits a `jobs` meter of `cost`, and returns `202 {job_id:'p1'}`; assert an unknown template → 404; malformed body → 422; unknown param → 422.
- [ ] **Step 2–4:** RED → implement breed → GREEN (`pnpm test comfyui-handle`).
- [ ] **Step 5: Commit** — `git commit -m "feat(connectors): comfyui breed handle (template submit, job record, jobs metering)"`

---

### Task 7: JobStore (in-memory) in the data plane

**Files:** Create `apps/data-plane/src/jobs/job-store.ts`. Test: `apps/data-plane/test/job-store.test.ts`.

**Interfaces:** `InMemoryJobStore implements JobStore` (from `@metamodels/connectors`) — `create` sets `metered:false`; `get` returns the record or null; `markMetered` flips the flag. (Redis/Postgres impl deferred to Plan 4/5.)

- [ ] **Steps:** TDD create/get/markMetered + "get unknown → null"; `pnpm test job-store`; commit `feat(data-plane): in-memory JobStore`.

---

### Task 8: Wire `handle` + the scoped result route into the app

**Files:** Modify `apps/data-plane/src/app.ts`, `apps/data-plane/src/breeds.ts` (register `comfyuiBreed`). Create `apps/data-plane/test/helpers/fake-comfyui.ts`. Test: `apps/data-plane/test/comfyui.integration.test.ts`.

**Behavior:**
- After rate-limit, if `breed.handle` is defined, build a `BreedIO` (wiring `upstream`/`upstreamRaw` to `proxyToUpstream`/`fetchImpl` against `paddock.flock`, `emitMeter` to the meter sink with `paddock` ids, and the injected `JobStore`) and return `breed.handle(ctx, fence, io)` as the response. Otherwise run the existing generic path (Ollama).
- Add `GET /p/:slug/result/:jobId`: authenticate + scope as usual; `job = jobStore.get(jobId)`; if `!job || job.keyId !== resolvedKey.keyId` → 404 (don't leak). Fetch `/history/{jobId}` via the flock; `outcome = parseHistory(...)`; if `outcome.done && !job.metered`: emit `images` + `gpu_ms` meters and `markMetered`. Return `{ done, images }` (a scoped view — never the raw `/history` or a direct `/view` URL; image bytes are fetched through a further scoped sub-route if needed, deferred).
- `createApp` deps gain `jobStore: JobStore`.

- [ ] **Step 1: Write the failing integration test** — seed a pglite paddock whose fence embeds a template (inline v0.3.2-shaped graph); use `fake-comfyui.ts` as `fetchImpl`. Assert: submit → `202 {job_id}` + a `jobs` meter; result before completion → `{done:false}`; result after completion → `{done:true, images:[...]}` + `images`/`gpu_ms` meters emitted exactly once (a second result fetch does not double-meter); a `result` for another key's job → 404; a raw `/p/slug/prompt` (bypass attempt) → guard 403.
- [ ] **Step 2–4:** RED → implement app wiring + fake-comfyui → GREEN (`pnpm test comfyui.integration`), then full `pnpm test` + `pnpm typecheck`.
- [ ] **Step 5: Commit** — `git commit -m "feat(data-plane): comfyui handle wiring + scoped result route + history metering"`

---

### Task 9: Server registration + docs

**Files:** Modify `apps/data-plane/src/server.ts` (construct an `InMemoryJobStore` and pass to `createApp`), `apps/data-plane/README.md` (document the ComfyUI `{template_id,params}` submit + `result/:jobId` contract and the template/security model). Test: extend `server-config` only if the config surface changes (it doesn't — no new env). 

- [ ] **Steps:** wire `jobStore` into `startServer`; update README; `pnpm test && pnpm typecheck`; commit `feat(data-plane): register comfyui breed + jobstore in server; docs`.

---

## Plan 3 Self-Review

- **Spec coverage:** template model + server-side graph reconstruction ✓ (Task 4); raw-graph structurally impossible (ingress is `{template_id,params}`; `guard` hard-denies direct routes) ✓ (Tasks 4,6,8); image-upload param (base64→/upload/image→LoadImage) ✓ (Tasks 4,6); scoped result route, `/view`+`/history` never exposed ✓ (Task 8); job ownership + 404-not-403 ✓ (Tasks 7,8); metering jobs/images/gpu_ms once-per-job ✓ (Tasks 5,6,8); latex.pics v0.3.2 / v0.3.2-img wrappable ✓ (Tasks 4,8 fixtures). `/ws` live progress relay and multipart ingress are explicitly deferred.
- **Consumed carry-forwards:** content-type-agnostic path ✓ (Task 1); metering seam moved out of proxy ✓ (Task 2); tee memory for image bytes — result images are fetched on demand via a scoped route, not streamed through the tee, so the Plan-2 tee concern doesn't apply to ComfyUI outputs (noted).
- **Placeholder scan:** Tasks 1–4, 6 carry full code; Tasks 5, 7, 9 are described with exact interfaces + rules and are mechanical enough to implement without ambiguity, but the implementer must still write real tests (the brief for each names the exact assertions). No TBD/TODO.

## Deferred to later milestones
- Live `/ws` progress relay to the consumer (v1 uses poll-based `result`).
- Multipart ingress (v1 uses base64 image params).
- Scoped image-byte fetch sub-route (`result/:jobId/image/:idx`) proxying `/view` for the caller's own outputs only.
- Node-allowlist "sandbox" Paddocks (templates-only in v1, per the design spec).

## Next milestone
Plan 4 — Worker & rollups (Redis-backed `RateLimiter`/`MeterSink`/`JobStore`, `usage_rollup` with the composite-unique + upsert from the Plan 1 carry-forward, hard quota caps).
