# MetaModels — Design Spec (v1)

- **Date:** 2026-07-25
- **Status:** Approved for planning
- **License:** AGPL-3.0
- **Repo:** `~/Projects/metamodels` · branch `main` · identity `Carmelo Santana <me@carmelosantana.com>`

---

## 1. Summary

MetaModels is a **self-hosted, local-first governance-and-monetization proxy** that sits in
front of otherwise-unprotected local AI servers and gives them what they lack on their own:
authentication, API keys, rate limiting, fine-grained per-provider constraints, and usage
metering. v1 ships two provider connectors — **Ollama** (LLM) and **ComfyUI** (image/graph) —
on a shared connector SDK, so a third connector is additive rather than a rewrite.

**Positioning:** *"Cloudflare AI Gateway meets Stripe, self-hosted — and it speaks ComfyUI,
not just chat."* The competitive landscape splits cleanly and leaves this intersection open:
the LLM-gateway pack (LiteLLM, Portkey, Kong, Bifrost, Higress, TrueFoundry) is tunnel-visioned
on OpenAI-style chat traffic and does internal cost-*tracking* rather than customer-*billing*;
the ComfyUI camp (ComfyDeploy, ViewComfy, RunComfy) are workflow-*hosting* platforms, not a
governance proxy you drop in front of an existing local install. Nobody delivers
**{local-first + ComfyUI-graph-aware + built-in monetization}** together.

**v1 goal:** a self-hoster runs one MetaModels instance in front of their own local Ollama and
ComfyUI, publishes constrained, metered access points, and issues API keys to consumers.
Billing, MCP generation, and dashboards are deliberately deferred but seamed for.

### Naming metaphor (border-collie / herding)

Placeholder domain names, to be finalized with the designer:

| Term | Meaning |
|---|---|
| **Breed** | A connector *type* (`ollama`, `comfyui`) — code-defined. |
| **Flock** | A connected upstream *instance* (your Ollama at a URL; your ComfyUI box). |
| **Paddock** | A published, fenced view onto a Flock — the public URL consumers hit. The central noun. |
| **Fence** | The policy on a Paddock (allowlists + rate limit + quota). |
| **Key** | A consumer's API key (`mm_live_…`), scoped to one or more Paddocks, metered per call. |

---

## 2. Scope

### In v1

- pnpm monorepo: `packages/connectors`, `packages/schema`, `apps/data-plane`, `apps/control-plane`, `apps/worker`.
- **Data plane** (Hono): key auth, rate limit + quota, fence enforcement, streaming proxy (NDJSON passthrough + ComfyUI `/prompt`+`/ws` relay), scoped result endpoint, meter emission.
- **Ollama breed** and **ComfyUI breed** (template model), each meeting acceptance fixtures.
- **Control plane** (Next.js + shadcn): operator login; CRUD for Flocks, Paddocks, Fences, WorkflowTemplates, API Keys; plain usage view; health status; audit log.
- **Infra:** Postgres + Redis; 5-service `docker compose`; AGPL-3.0; README + setup docs.

### Out of v1 (deferred, with the seam that makes it additive)

| Deferred | Seam in place |
|---|---|
| Stripe billing (subscription / timed usage / token) | `UsageRollup` keyed by key×paddock×dimension; `Breed.billingDimensions` |
| API → realtime MCP generation | `Breed.toMcp?()` defined but unwired |
| Rich analytics dashboards | v1 ships plain usage tables; charts layer on later |
| Multi-tenant SaaS (many operators/orgs) | `org` FK on every entity; only auth stays single-operator |
| Additional breeds (A1111/Forge, vLLM/TGI, generic OpenAI-compat, Whisper/TTS) | SDK + `constraintSchema`-driven admin form make a new breed additive |

### Non-goals

- MetaModels does **not** run, install, or manage the upstream AI servers. It connects to
  existing Ollama/ComfyUI instances by URL.
- v1 is **not** multi-operator SaaS. One instance = one operator org.

---

## 3. Architecture

### 3.1 Control plane / data plane split

`security and performance are critical` for something in the hot path of streaming inference,
so the byte-pushing proxy and the config/admin app are separate runtimes.

```
                          ┌─────────────────────────────────────┐
  Consumers ── mm_live_… ─▶│  DATA PLANE  (Hono, public)         │──▶ Ollama  (Flock)
  (their apps)            │  auth · rate-limit · fence enforce   │──▶ ComfyUI (Flock)
                          │  NDJSON/WS streaming · meter emit    │      (external, by URL)
                          └───────┬──────────────────┬──────────┘
                                  │ key cache /       │ meter events
                                  │ rate counters     ▼
                                  ▼            ┌──────────────┐
                            ┌──────────┐       │  Redis        │
                            │  Redis   │◀──────│  streams      │
                            └──────────┘       └──────┬───────┘
                                  ▲ config invalidate  │ roll-up
  Operator ──── login ──▶ ┌───────┴──────────┐   ┌────▼─────┐   ┌──────────┐
  (admin)                 │ CONTROL PLANE     │──▶│ WORKER   │──▶│ Postgres │
                          │ Next.js + shadcn  │   │ rollup/  │   └──────────┘
                          │ config API + UI   │   │ health   │
                          └───────────────────┘   └──────────┘
```

- **Only the data plane is publicly exposed.** The control plane sits on a separate
  port/domain behind operator auth. Flock (upstream) URLs are **server-side only** and never
  reachable by consumers.
- Upstreams are external — pointed at by URL (same host via `host.docker.internal`, or a
  remote GPU box).

### 3.2 Monorepo layout (pnpm workspaces)

Connectors are genuinely shared TypeScript imported by both planes.

```
packages/
  connectors/     Breed SDK + `ollama` + `comfyui` breeds
  schema/         Drizzle schema + shared Zod types
apps/
  data-plane/     Hono proxy (public)
  control-plane/  Next.js 15 + shadcn admin
  worker/         Redis-stream consumer: meter roll-up, health probes
```

### 3.3 Data stores

- **Postgres 16 (Drizzle ORM):** source of truth for all config + usage rollups.
- **Redis 7 (hot path):** key→policy cache, sliding-window rate/quota counters, meter-event
  stream, and a config-invalidation pub/sub channel. **The hot path never touches Postgres
  per-request.** Editing a Paddock publishes an invalidation that drops the data plane's cache.

---

## 4. Domain model

Org-ready single-operator: one implicit `org` row in v1, `org_id` FK on every entity, so
multi-tenant becomes a later config flip rather than a schema migration.

| Entity | Shape / notes |
|---|---|
| **Org** | Single row in v1. The seam for future multi-tenancy. |
| **User** | Operator/admin accounts within the org. |
| **Breed** | Code-defined connector type (`ollama`, `comfyui`); not a table — a Flock references it by id string. |
| **Flock** | `{org_id, breed, name, base_url, upstream_auth?, tls_trust?, health}` — a connected upstream instance. |
| **Paddock** | `{org_id, flock_id, slug, name, status}` — the public access point. |
| **Fence** | `{paddock_id, constraint_json (breed-specific, Zod-validated), rate_limit, quota}`. |
| **WorkflowTemplate** | (ComfyUI) `{flock_id, name, graph_json, param_schema[], cost}` — referenced by ComfyUI fences; the product/pricing unit. |
| **ApiKey** | `{org_id, name, hash (SHA-256), prefix, status, expires_at, overrides}`. Stored hashed; `mm_live_…` prefix. |
| **KeyPaddock** | Join — a Key may access multiple Paddocks. |
| **UsageRollup** | Aggregated meter dims `{tokens_in, tokens_out, jobs, gpu_ms, images}` per key×paddock×period. Billing-ready seam. |
| **AuditLog** | Every admin/config mutation. |

Request identity chain: **Consumer → Key → Paddock → Fence (enforce) → Flock → upstream**,
with meter events emitted at the Paddock, keyed by Key.

---

## 5. Connector SDK — the Breed contract

One interface, imported by both planes. `constraintSchema` does double duty: it validates a
Fence's `constraint_json` **and** auto-generates the admin config form, which is what keeps a
third breed cheap.

```ts
interface Breed<C> {
  id: string                          // 'ollama' | 'comfyui'
  displayName: string
  routes: RouteSpec[]                 // {method, path, class:'read'|'infer'|'mutate', exposeByDefault}
  constraintSchema: ZodSchema<C>      // what a Fence may restrict; renders the admin form
  health(flock): Promise<HealthStatus>
  guard(ctx, fence: C): GuardResult   // allow + rewritten-request | deny(reason)  ← enforcement
  meter(ctx, upstream): MeterEvent[]  // usage extraction → billing seam
  billingDimensions: MeterDim[]       // e.g. ['tokens_in','tokens_out'] | ['jobs','gpu_ms','images']
  toMcp?(fence: C): McpToolDef[]       // fast-follow, defined but unwired in v1
}
```

Supporting types (illustrative):

```ts
type RouteClass = 'read' | 'infer' | 'mutate'
type MeterDim   = 'tokens_in' | 'tokens_out' | 'jobs' | 'gpu_ms' | 'images'
type GuardResult =
  | { ok: true;  request: RewrittenRequest }
  | { ok: false; status: 401 | 403 | 422; reason: string }
type MeterEvent = { dim: MeterDim; value: number; at: number }
```

### 5.1 Ollama breed

Reference: Ollama listens on `:11434`, ships with **zero auth**, streams **NDJSON**, and
exposes a cluster of dangerous model-management endpoints.

- **Route classification** drives the default policy:
  - **INFER** (allowlistable): `/api/generate`, `/api/chat`, `/api/embed`, `/api/embeddings`, and the OpenAI-compatible `/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`.
  - **READ** (safe metadata): `/api/tags`, `/api/show`, `/api/ps`, `/api/version`, `/v1/models`.
  - **MUTATE (hard-denied, not exposable in v1):** `/api/pull`, `/api/push`, `/api/create`, `/api/copy`, `/api/delete`, `/api/blobs`. These are the disk-fill, model-exfil, and delete vectors.
- **Constraints (`C`):** `allowedModels` — an explicit list **or** a size bound `{maxParamB?, maxSizeBytes?}`; `allowedRoutes` ⊂ `{chat, generate, embed, read}`.
- **guard:** reject `body.model` not on the allowlist / over the bound, checked against a
  cached `/api/tags` map (`details.parameter_size`, `size`) — never trust client-supplied
  size. Reject any MUTATE route. On `/v1` streaming, inject `stream_options.include_usage` so
  the usage object is never lost.
- **meter:** read the **final NDJSON line** (streaming) or sole object (non-streaming):
  `tokens_in = prompt_eval_count`, `tokens_out = eval_count`; also capture `eval_duration` /
  `total_duration` for GPU-time. A missing count (prompt served from cache) counts as `0`, not
  an error.
- **billingDimensions:** `['tokens_in', 'tokens_out']`.

### 5.2 ComfyUI breed

Reference: ComfyUI listens on `:8188`, has **no built-in auth**, and `POST /prompt` executes
an **arbitrary node graph = remote code execution**. Real workflows depend heavily on custom
nodes, so a core-node allowlist is a non-starter — hence the template model.

- **Constraint model — templates as the product, node-allowlist as the primitive underneath.**
  A Paddock exposes a set of pre-approved `WorkflowTemplate`s. The consumer never submits raw
  node structure.
- **Template `param_schema`** — a whitelist of editable `{node_id, input_key}` targets;
  everything else in `graph_json` is frozen. Param types (grounded in the latex.pics
  workflows):
  - `text` → a node input (the prompt).
  - `image` → consumer upload, proxied to `/upload/image`, injected into a `LoadImage` node.
  - `seed` → auto-randomized (KSampler/KSamplerAdvanced/`noise_seed`) or bounded int.
  - `number` | `enum` → bounded (steps, cfg, width/height within min/max, sampler from a fixed set).
- **guard:** ingress body is `{template_id, params}` only. Validate params against the
  template's `param_schema`, then **reconstruct the full graph server-side** and submit
  `/prompt`. A consumer-supplied `class_type` is structurally impossible.
- **Result retrieval:** the proxy exposes a **scoped** `GET /p/{slug}/result/{jobId}` that maps
  only to that job's own `/history` + `/view` outputs. `/view` and `/history` are **never**
  exposed directly, killing path-traversal and cross-consumer output access.
- **meter:** tee the upstream `/ws` for the job's `prompt_id`: `execution_start → executed`
  yields `gpu_ms`; count `output.images` yields `images`; `+1 jobs`. Reconcile against
  `/history/{prompt_id}` at completion. `execution_cached` frames indicate cheaper work.
- **billingDimensions:** `['jobs', 'gpu_ms', 'images']`.
- **Version drift:** ComfyUI routes and node schemas drift between releases — the breed pins to
  the deployed version and reads `/object_info` to validate templates on import.

### 5.3 Acceptance fixtures

MetaModels must be able to wrap the latex.pics workflows as Paddock templates (used as the
proof-of-concept target; the workflow JSON is *not* copied into this repo):

- **`v0.3.2.json`** — txt2img: expose `{prompt, auto-seed}`; freeze the rest, including custom
  nodes (`TextEncodeQwenImageEditPlus`, `StringFunction|pysssss`, `OllamaGenerateV2`,
  `ModelSamplingAuraFlow`, `UpscaleModelLoader`, `EsesImageCompare`).
- **`v0.3.2-img.json`** — img2img: additionally expose an `image` param injected into the
  `LoadImage` node.

---

## 6. Request lifecycle (data-plane hot path)

```
POST /p/{paddock-slug}/…   (mm_live_ key in Authorization or x-api-key)
  1. AuthN     hash key → Redis lookup → {key, org, paddock scope, overrides}     ✗ → 401
  2. Limits    Redis sliding-window (key×paddock) + quota; ComfyUI uses template cost
                                                                                   ✗ → 429 + Retry-After
  3. Guard     breed.guard(ctx, fence) → rewritten request | deny(reason)         ✗ → 403 (reason)
  4. Proxy     stream to Flock: NDJSON passthrough (Ollama) / submit + relay /ws (ComfyUI)
  5. Meter     breed.meter → MeterEvent → Redis stream   (never blocks the response)
  6. Worker    drains stream → UsageRollup (Postgres) + enforces hard quota caps
```

- Rate limiting is a Redis sliding window keyed by `(key, paddock)`, with per-paddock defaults
  and optional per-key overrides, plus a global instance ceiling. Breaches return `429` +
  `Retry-After`.
- Metering is fire-and-forget onto a Redis stream so it never adds latency to the response; the
  worker aggregates into `UsageRollup` and enforces hard quota caps out of band.

---

## 7. Security posture (defaults, not options)

- Only the data plane is public; **Flock URLs are server-side only** — upstreams are never
  directly reachable by consumers.
- **Ollama:** the entire MUTATE class is hard-denied and not exposable in v1.
- **ComfyUI:** raw-graph submission is structurally impossible through a Paddock; `/view` and
  `/history` are never exposed directly; the scoped result endpoint blocks path-traversal and
  cross-consumer access. Node graphs are pre-approved by the operator (custom nodes included).
- **Keys** are hashed at rest (SHA-256), prefix-shown in the UI, rotatable, and expirable.
- **Per-Flock TLS trust** option (handles self-signed upstreams like `comfyui.local`).
- **Audit log** on every config mutation; request logs redact bodies by default.
- Data plane is an API surface: no CORS by default (configurable per Paddock), standard
  security headers.

---

## 8. Stack

| Layer | Choice |
|---|---|
| Language | TypeScript end-to-end |
| Data plane | Hono on Node 22 |
| Control plane | Next.js 15 + React + shadcn/ui + Tailwind |
| DB / ORM | Postgres 16 + Drizzle |
| Hot path | Redis 7 (key cache, counters, meter stream, pub/sub) |
| Validation | Zod (shared; drives admin forms) |
| Operator auth | Auth.js (NextAuth v5) credentials; single admin seeded via env |
| Worker | Node Redis-stream consumer (add BullMQ only if a need appears) |
| Packaging | Docker + docker compose (multi-stage images) |
| Tests | Vitest, TDD |
| License | AGPL-3.0 |

---

## 9. Testing strategy

- **Breed contract tests** — each breed's `guard()` / `meter()` against recorded fixtures: real
  Ollama NDJSON final-lines (streaming + non-streaming, incl. cache-hit with missing counts),
  real ComfyUI `/ws` sequences, and the latex.pics `v0.3.2` graphs as template fixtures.
- **Data-plane integration** — fake Ollama + fake ComfyUI upstreams exercising the full
  lifecycle including deny paths, `429`s, quota caps, and template-reconstruction correctness.
- **Security tests** — MUTATE routes denied; raw-graph rejected; result-endpoint path-traversal
  blocked; cross-key output isolation.
- **Control plane** — API-route + component tests.
- Build executed via **subagent-driven-development** with TDD.

---

## 10. Open questions for the plan phase

These are deliberately left for `writing-plans`, not blockers on the design:

1. **Build order** — recommend: schema/SDK → data-plane core (auth/limits/guard) → Ollama breed
   end-to-end → ComfyUI breed end-to-end → control-plane CRUD → worker/rollups → docker compose.
2. **ComfyUI progress relay to the consumer** — proxy re-emits upstream `/ws` as its own
   WebSocket vs. SSE vs. poll-only `result/{jobId}`. Poll-only is the simplest v1; live relay
   is a fast-follow.
3. **Template authoring UX** — how the operator marks `{node_id, input_key}` as editable in the
   `param_schema` editor (paste graph JSON + click-to-expose vs. a guided form). Designer input.
4. **Quota reset semantics** — rolling window vs. calendar period; per-key vs. per-paddock
   caps precedence.

---

## Appendix — competitive landscape (for positioning)

- **Closest overall — LiteLLM:** matches keys/rate-limits/MCP and has generic pass-through, but
  no ComfyUI-graph awareness and only internal cost-tracking (not customer billing).
- **Closest on API→MCP — Higress MCP Marketplace:** "API is MCP" for generic REST, no billing,
  no ComfyUI node awareness.
- **Closest on ComfyUI — ComfyDeploy (AGPL-3.0):** a workflow *hosting/orchestration* platform,
  not a governance proxy in front of an existing local install; no Ollama, no unified billing.
- **Billing precedent:** Stripe token-billing exists but is LLM-token-only and partner-gated;
  RunComfy proves per-GPU-second / per-job image billing is viable but only as a closed host.

Durable moat: **ComfyUI-graph-aware governance + self-hosted monetization across both token and
per-job/GPU-second dimensions** — a combination neither the LLM-gateway camp nor the ComfyUI
platform camp is structurally positioned to build.
