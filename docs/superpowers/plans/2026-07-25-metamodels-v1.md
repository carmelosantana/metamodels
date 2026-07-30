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
| **6** | **Packaging & integration** (split 6a/6b/6c) | **6a ✅ SHIPPED** (`7356e2f`): `docker compose up` runs all services; multi-target images; env config; migrate runner; healthcheck; smoke; README + DEPLOY docs. **6b ✅ SHIPPED** (`9846fe9`): CI workflow (both lanes on PG+Redis service containers, build-before-typecheck, build-smoke job) + zizmor required check + CODEOWNERS + real-PG per-org-lock concurrency test + real-Redis config pub/sub smoke + integration-test runbook. **6c** (remaining): LS re-validation scheduler (`apps/scheduler`). | repo root, `docker/`, `docs/`, `apps/migrate`, `.github/`, `apps/scheduler` |

### Carry-forward from Plan 1 whole-branch review (must be honored when expanding later plans)

- **Plan 2:** consider typing the Breed's `constraintSchema` as `z.ZodType<C>` (not `ZodTypeAny`) when the Ollama breed first parses a real Fence — preserves the parse→`guard(fence: C)` type linkage the spec's "double duty" relies on.
- **Plan 3:** validate that the data-plane "collect the full upstream outcome into `UpstreamResult`, then call sync `meter()`" split actually holds for ComfyUI's `/ws`→`/history` reconciliation. If reconciliation must happen inside `meter`, widen it to `MeterEvent[] | Promise<MeterEvent[]>` (symmetry with async `guard`).
- **Plan 4 (correctness-critical):** add a composite UNIQUE on `usage_rollup (org_id, key_id, paddock_id, period, dim)` and implement the worker aggregation as `INSERT … ON CONFLICT (…) DO UPDATE SET value = value + excluded.value`. Without the constraint the worker is pushed into read-modify-write races or duplicate rows. Drizzle migrations are additive, so introduce it in Plan 4.
- **Plan 5 / multi-tenant future:** `key_paddock` has no `org_id` (accepted: transitively org-scoped via parents). When org count > 1, app-layer validation must prevent linking a key in org A to a paddock in org B (no composite FK enforces org consistency), and consider a UNIQUE on `(key_id, paddock_id)` to prevent duplicate scope rows.

### Carry-forward from Plan 2 whole-branch review (honor when expanding later plans)

- **Plan 3 (ComfyUI) — foundation, IMPORTANT:** the data-plane request path is currently JSON-only (`app.ts` hardcodes `content-type: application/json`; the proxy `JSON.stringify`s the body) and metering extraction lives in `readOutcome` assuming UTF-8/JSON text. ComfyUI needs multipart image uploads and **binary image responses**. Before Plan 3: (a) make the app/proxy content-type-agnostic (pass non-JSON bodies through untouched), and (b) move the metering-extraction seam **into `breed.meter`** over a raw buffer/stream rather than parsing in the proxy. Also revisit the teed client branch buffering unbounded image bytes in memory (cap or stream-to-disk).
- **General proxy:** preserve the query string in the upstream path (currently dropped in `app.ts` — harmless for Ollama's body-driven API, matters generally).
- **Plan 5 (control plane):** validate a Fence's `constraint_json` on write (removes the only bare-500 path — malformed stored config); enforce key↔paddock **org consistency** at write time (meter attribution uses `paddock.orgId` while the scope check is slug-only, so a cross-org `keyPaddock` link would misattribute usage).
- **Plan 4:** swap the Redis-backed `RateLimiter`/`MeterSink` at the two `server.ts` constructor args (README documents the point). Note: the in-memory sliding-window-log semantics won't map 1:1 onto a Redis token bucket — keep the interface, expect a behavioral diff; Redis TTL also solves the in-memory limiter's lack of idle-bucket eviction.
- **Hygiene (any time):** add an `app.onError` boundary returning clean JSON for unexpected errors; validate `Number(PORT)` (throw on `NaN`); match the `Bearer` scheme case-insensitively.

### Carry-forward from Plan 3 whole-branch review (honor when expanding later plans)

- **Plan 4 (durable JobStore):** the Redis/Postgres `JobStore` must implement `markMetered` as a real atomic compare-and-set across instances (Redis `SET key NX` / Postgres `UPDATE ... WHERE metered = false RETURNING`). The in-memory CAS (single-process) is only correct for one instance. Also give the durable metering sink an emit-failure retry story — today a failed `emitScoped` still marks the job metered (best-effort; images/gpu_ms usage lost on sink failure).
- **`ReadableStream` body needs `duplex: 'half'`** (`proxy.ts`): the stream-body branch added in Plan 3 Task 1 is dead today (no route produces a stream body) but will throw in undici without `init.duplex = 'half'`. Add it when the first streaming request body is wired.
- **Content-type behavior delta (Plan 2→3):** a request POSTing JSON *without* a `content-type` header is now treated as raw text (previously always JSON-parsed). More correct, but note it if any client relied on the old behavior.
- **ComfyUI base64 image size cap:** consumer image params are base64 in the JSON body and held fully in memory — add a request-body/param size limit before production (still open from Plan 2).
- **`handle` owns all non-direct paths:** the ComfyUI submit isn't bound to a literal `/submit` route — any non-direct path under `/p/:slug/*` with a valid `{template_id,params}` body is a submit. Fine for a single-`handle` breed; consider an explicit route match if a breed ever needs multiple `handle` endpoints.
- **Deferred (still, per design spec):** live `/ws` progress relay to the consumer; multipart ingress; a scoped image-byte fetch sub-route (`result/:jobId/image/:idx` proxying `/view` for the caller's own outputs only); node-allowlist "sandbox" Paddocks.

### Carry-forward from Plan 4 whole-branch review (honor when expanding later plans)

Plan 4 shipped (branch `feat/metamodels-plan4`, merged to `main`): durable metering via a Redis stream + `apps/worker` consumer → `usage_rollup` upsert (composite UNIQUE `usage_rollup_key`); `PostgresJobStore` atomic-CAS `markMetered` (now also `onConflictDoNothing` on duplicate `jobId` — matches the in-memory no-throw contract, preserves `metered`/ownership); `RedisRateLimiter` (atomic Lua ZSET sliding-window); hard quota caps read from rollups; env-driven `server.ts` (Redis vs in-memory) + `/healthz`/`/readyz`. 163 tests pass, 3 skipped.

- **Plan 6 (real-Redis integration — REQUIRED):** the worker consumer-group wiring test (`apps/worker/test/worker.test.ts`, `processOnce` read→apply→ack) is `describe.skipIf(!process.env.REDIS_TEST_URL)` because `ioredis-mock@8.9.0` has NO consumer-group commands (throws on `xgroup`). Its 3 cases (+ any future real-Redis cases) MUST run against a real Redis in the docker-compose integration suite. `RedisRateLimiter` IS mock-green (ioredis-mock runs the Lua ZSET), but a real-Redis smoke of it there is still worthwhile. Aggregation correctness itself is fully covered Docker-free by the pglite `applyEvents` tests.
- **Exactly-once metering (at-least-once today):** `processOnce` commits the rollup upsert BEFORE `XACK`, so a crash between them redelivers a batch and re-sums it (over-count, never under-count). Add per-message dedup (processed-offset table or stream-id tracking) if crash-time double-count becomes unacceptable — Plan 6 (needs the real-Redis harness). Also: a single undecodable stream entry throws in `readBatch` and aborts that whole batch's apply; add a dead-letter / `XAUTOCLAIM` reclaim path for stuck PEL entries — Plan 6.
- **Quota is a soft-ish hard cap:** enforcement reads already-aggregated `usage_rollup`, which lags the stream by worker latency, and the check is pre-request (one in-flight request can cross the cap before it is counted). Acceptable for v1. For a truly synchronous ceiling, maintain a Redis counter incremented at emit time. Also a malformed `fence.quota` fails OPEN (gate skipped, request allowed) by design — a bad config silently disables the cap; consider a one-time warn log so it's observable. Quota gate also issues N sequential rollup reads per request on the hot path (small N; fine now).
- **Dev (in-memory) mode ⇒ quota unenforced:** with no `REDIS_URL`, meters go to `InMemoryMeterSink`, no worker drains them, so `usage_rollup` stays empty and every quota check reads 0. Documented in `server.ts`. Production MUST set `REDIS_URL` and run `apps/worker`.
- **Plan 5 (ConfigStore caching): ✅ SHIPPED (Plan 5.6)** — `CachingConfigStore` paired with Redis pub/sub invalidation; see the dedicated Plan 5.6 carry-forward section below.
- **Hardening (any time / Plan 6):** `RedisMeterSink.emit` uses a pipeline whose per-command `XADD` errors are not inspected (a rejected entry is lost usage with no signal) — scan `exec()` results and log. `server.ts` opens `postgres` + `Redis` and never closes them (no SIGTERM/graceful drain). `app.ts` awaits `breed.handle` with no try/catch, so any `handle` throw (e.g. a future durable-store error) surfaces as a bare 500 — wrap it. `decodeMeterEvent` locates the `data` field by `indexOf` and its `JSON.parse` is unguarded — harden if the single-field codec ever grows. Stream retention is a coarse `MAXLEN ~ 100_000`; size to worker throughput (or time-based `MINID`) later.
- **Test-coverage gaps (non-blocking):** no test drives an over-cap rollup through the ComfyUI `handle` branch (the gate structurally covers it — it sits before the handle/generic split); the worker's `XACK` isn't truly exercised by the wiring test (`XREADGROUP >` won't redeliver delivered-but-unacked entries either — needs XPENDING/second-consumer, Plan 6).

### Carry-forward from Plan 5.1 whole-branch review (honor when expanding later plans)

Plan 5.1 shipped (branch `feat/metamodels-plan5.1`, merged to `main`): the `apps/control-plane` Next.js 16 operator console — multi-user-capable auth (scrypt password + HMAC-signed httpOnly session cookie, all Node `crypto`, no third-party lib), the `authorize(user, action)` capability matrix (admin/member/viewer), the reusable server CRUD template (requireCapability → Zod → org-scope → **mutation+audit in one `db.transaction`**), Flocks CRUD + Test-connection (screen 9a), the additive `user.status` migration (`0002`), and hand-authored operator-mode UI primitives. Logic lives in Next-free modules tested with vitest+pglite; RSC/Server Actions are thin shells. Root 164 pass/3 skip + control-plane 32 pass; `tsc -b` clean. **Multi-user is mechanism-only — adding a 2nd user is gated until Plan 5.7 (only the seeded admin exists).**

- **Plan 5.7 (multi-user paid surface):** (a) close the `verifyLogin` timing oracle — run a **dummy `verifyPassword` against a fixed hash on the unknown-email miss path** so latency doesn't distinguish known vs unknown emails (today it returns before hashing; the generic `invalid` reason + per-IP throttle partially mitigate). (b) Re-introduce a page-level capability guard (the `requireCapabilityOr403` deleted in 5.1 as unwired dead code) when the **Team / Settings** admin pages that need it exist. (c) Link `authorize.ts`'s local `Role` union to schema `USER_ROLES` (a `satisfies` bridge or import) so a new role can't silently miss the capability matrix — do it when 5.7 touches roles.
- **Plan 6 (CI / packaging — required):** control-plane `pnpm typecheck` (`tsc -b`) needs a prior `next build`/`next typegen` because `next-env.d.ts` imports the gitignored `.next/types` — CI must build (or typegen) the app **before** typechecking it, or a cold clone fails. The login **throttle assumes a trusted reverse proxy sets `X-Forwarded-For`** (the code takes the first hop, which is client-spoofable without a trusted proxy that overwrites it) — document in deploy notes and set it in the compose/proxy config. The throttle is **in-memory per-process** — a multi-node deploy needs a shared store (reuse the data-plane Redis limiter concept). Keep control-plane on `next@≥16.2` with security headers (already pinned `16.2.0`).
- **Toolchain note (Turbopack workaround):** control-plane builds with **webpack** (`next build --webpack`) plus `transpilePackages` + `experimental.extensionAlias` in `next.config.ts`, because Turbopack (the Next 16 default) can't resolve the workspace packages' repo-wide `.js`→`.ts` NodeNext barrel specifiers. Contained to control-plane (shared packages + data-plane/worker untouched). **Revisit** dropping the workaround when Turbopack gains extension-alias support, or emit the shared packages to `dist` + repoint their `exports` (bigger change; touches shared packages).
- **Fonts self-hosted:** operator mode uses `next/font/google` (IBM Plex Sans/Mono) — build-time self-host, no runtime external request. Keep it that way (a self-hosted privacy product must not phone Google Fonts). Press Start 2P (MetaBoy/consumer track) is out of scope until the consumer playground plan.
- **Cosmetic/polish (next Flocks touch):** `deleteFlockAction` lacks the `{error}` try/catch that `saveFlockAction` has (a forged/already-gone delete surfaces as an unhandled server-action error — fails closed, ugly UX); the drawer scrim `bg-black/50` is the one non-tokenized color; `seed.ts`'s `created:false` path returns a hardcoded `role:'admin'` instead of echoing `u.role` (harmless — seed only makes admins).
- **Audit-transaction pattern is now the template:** Plans 5.2–5.7 CRUD services MUST copy the `db.transaction(mutation + writeAudit)` shape from `flocks-service.ts` (so a failed audit rolls back the mutation — no unaudited changes). Do not regress to the two-statement form.

### Carry-forward from Plan 5.2 whole-branch review (honor when expanding later plans)

Plan 5.2 shipped (branch `feat/metamodels-plan5.2`, merged to `main`): publish a fenced Paddock end-to-end. Adds migration `0003` (`paddock.theme` plain↔MetaBoy + a `fence_paddock` unique index for one-fence-per-paddock); `paddocks-service` (org-consistent CRUD — a Paddock may only attach to a Flock in the same org; globally-unique slug with a friendly `SlugTakenError`; status toggle); `fences-service` with **constraint validated on write** against the breed's own `constraintSchema` (Ollama's enum has no `mutate` → model-management is structurally unexposable) + `rateLimit`/`quota` validated with local Zod; `computeBlastRadius`; screens 9b (Paddocks) + 9c (Fence editor, `mutate` shown locked). Every mutation copies the 5.1 tx CRUD template. Root 166 pass/3 skip + control-plane 55 pass; `tsc -b` clean. The whole-branch review found no fix-now items — config-shape parity with the data-plane is exact (the control-plane validates with the *same* `@metamodels/connectors` schemas the data-plane re-parses, closing the fail-open-on-malformed-quota hole at the source).

- **Plan 5.4 (schema hoist + Keys): ✅ SHIPPED** — see the dedicated carry-forward section below. (Fence config + graph schemas hoisted to client-safe `@metamodels/schema/config` + `/graph` subpaths; key↔paddock org consistency enforced; screen 9d mints shown-once keys.)
- **Plan 5.3 (paramSchema editor): ✅ SHIPPED** — see the dedicated carry-forward section below. (Templates are now authored server-side via screen 8b; the 9c round-trip + page-bloat are gone.)
- **Cosmetic/polish (next Paddocks touch):** `togglePaddockStatusAction`/`deletePaddockAction` lack the `{error}` try/catch that `savePaddockAction` has (a not-found propagates as an unhandled server-action — unreachable via the honest org-scoped UI, cosmetic); the status toggle derives next-state from a client-supplied hidden field (org-scoped + capability-gated, no security impact). Consider `.positive()` on `rateLimit.max`/`quota.max` (a persisted `0` = deny-all on both apps; the 9c UI already guards it).
- **Deploy note (Plan 6):** the `CREATE UNIQUE INDEX fence_paddock` in migration `0003` will fail if a pre-existing deployment already holds >1 fence per paddock — essentially impossible on the pre-multi-user free tier, but the only non-trivially-additive behavior in the migration.

### Carry-forward from Plan 5.3 whole-branch review (honor when expanding later plans)

Plan 5.3 shipped (branch `feat/metamodels-plan5.3`, merged to `main` at `0fc7c29`): the **★ ComfyUI paramSchema editor (screen 8b)** — paste a workflow-API graph → bind typed params (text/seed/number/image) to node inputs → set cost → a dry-run runs the **real `reconstructGraph`** to prove round-trip → saved into `fence.constraint_json.templates` (the SAME `WorkflowTemplate[]` the data-plane consumes). Pure Next-free `template-schema.ts` + `template-builder.ts` (+ a client-safe `graph-parse.ts` leaf); `templates-service.ts` (org-scoped, comfyui-only, tx+audit, **constraint-only writes** so it never clobbers rate/quota). `saveFence` became **preserve-on-omit**, so the 9c fence editor no longer owns/round-trips ComfyUI templates (kills the 5.2 hidden-field round-trip + page-bloat + a latent clobber). No migration, no new dependency (templates live in the existing `constraint_json` jsonb). Control-plane 85 pass, root 166 pass/3 skip, `tsc -b` clean, both routes build. Whole-branch review: **no fix-now items** — the three security invariants (unknown-key rejected / seed server-generated / image-from-upload-slot) and the shared-fence-row no-clobber guarantee were confirmed end-to-end; config-shape parity is exact (editor validates through the connector's own `comfyuiConstraint`, so a data-plane reparse is idempotent).

- **Plan 5.4 (schema hoist — do FIRST, now expanded):** in addition to the fence config schemas (rate/quota — see 5.2 carry-forward), also promote the **client-safe** `graphSchema` + the pure `graph-parse.ts` (`parseGraphText`/`graphTargets`) into `@metamodels/schema` (or a genuinely client-safe shared package). Today the "`graph-parse.ts`/`template-schema.ts` must never import a *runtime* value from `@metamodels/connectors`" boundary (which keeps `node:crypto` out of the client bundle) is enforced only by convention/comments — `next build` catches a violation but a code review would not. Making it structural closes that. (Whole-branch advisory.)
- **Seed-target-overlap guard (roadmap hardening):** the 8b editor lets an operator declare a non-seed param (`text`/`number`) whose `(node,input)` target collides with a `seed` param's target; because `reconstructGraph` processes `params` in array order, a consumer-supplied value ordered after the seed can overwrite the auto-generated seed at request time. **Bounded** — it is operator misconfiguration *within a declared param* (not privilege escalation / cross-org; the connector's ordering behavior is pre-existing), so seed determinism (a quality property, not a security boundary) is the only casualty. Fix later with an editor warning and/or the connector rejecting a non-seed param that collides with a seed target. (Whole-branch Minor #1.)
- **Concurrent-save lost update (roadmap hardening):** `saveTemplate`/`deleteTemplate` are read-modify-write of the `templates[]` array inside one tx under READ COMMITTED — two operators saving different templates on the *same* paddock concurrently can lose one (the array-valued upsert makes this newly possible vs. the pre-5.3 scalar fence). Low likelihood on the single-operator free tier (multi-user is gated until 5.7); close with `SELECT … FOR UPDATE` (or a serializable tx) when multi-user lands. (Whole-branch Minor #2.)
- **Cosmetic/polish (next Templates touch):** `deleteTemplate` on a paddock that has no fence row yet materializes an empty fence row + a `template.delete` audit for a no-op (harmless — result `[]` is correct; could short-circuit when the id is absent); the 8b delete form discards the action's `{error}` (a failed delete surfaces nothing — matches the sibling Paddocks pattern); the editor's stale dry-run "✓ reconstructs OK" isn't cleared when the draft is edited (only on Edit-load); `sampleParam`'s `min ?? 0` default could falsely reject a `number` param declared with `max < 0` and no `min` (very narrow). All Minor, none security-relevant.

### Carry-forward from Plan 5.4 whole-branch review (honor when expanding later plans)

Plan 5.4 shipped (branch `feat/metamodels-plan5.4`, merged to `main` at `79b30a8`; plan-doc `a68f392`): **(Phase A) the schema hoist** — `rateLimitSchema`/`quotaRuleSchema`/`quotaSchema` → **client-safe subpath `@metamodels/schema/config`**, and `graphSchema` + `parseGraphText`/`graphTargets`/`BuildResult` → **client-safe subpath `@metamodels/schema/graph`** (self-contained, inlines its own `WorkflowGraph` type to avoid a `schema→connectors` cycle; the old control-plane `graph-parse.ts` is deleted). The barrel `@metamodels/schema` stays server-only (it re-exports `keys.ts`→`node:crypto`); clients import the subpaths. A structural **allowlist** guard (`packages/schema/test/client-safe.test.ts`) asserts `config.ts`/`graph.ts` import ONLY `zod`/`./enums.js` — the boundary is now test-enforced, not convention (verified: an injected `import './period.js'` fails the guard). **(Phase B) API Keys (screen 9d)** — `keys-service.ts` (`createKey`/`listKeys`/`revokeKey`, org-scoped, tx+audit) + `key-schema.ts` + `/keys` route; a minted `mm_live_` key's plaintext is **shown once** (only `prefix`+SHA-256 `hash` persist), scoped to org-owned paddocks with **key↔paddock org consistency enforced at write time** (cross-org paddock → `NotFoundError`, atomic rollback, nothing written — this closes the meter-misattribution gap since attribution uses `paddock.orgId` while the data-plane scope check is slug-only), optional per-key rate override, revoke. `zod` added as a direct dep of `@metamodels/schema` (already-installed workspace version; first zod use in the package). No migration. Control-plane 94 pass, root 176 pass/3 skip, `tsc -b` clean, `next build --webpack` clean with `/keys` + `/paddocks/[id]/templates`. Whole-branch review: **no fix-now items** beyond the two applied in the fix wave (allowlist guard + `revokeKeyAction` try/catch); all five load-bearing invariants confirmed end-to-end.

- **Finish the config dedup (next data-plane touch):** the hoist unified the config **Zod schemas**, but the data-plane still hand-writes its `RateLimit` + `KeyOverrides` **interfaces** in `apps/data-plane/src/config/types.ts` and only consumes the hoisted `quotaSchema` (not `rateLimitSchema`). Re-point `config/types.ts`'s `RateLimit`/`KeyOverrides` at `@metamodels/schema/config` (infer from `rateLimitSchema`/`keyOverridesSchema`) to finish what the hoist started. (Whole-branch recommendation — no regression; the rate-limit shape was never unified on the data-plane side.)
- **`UNIQUE(key_id, paddock_id)` index (roadmap hardening — do with the 5.7 multi-user migration):** `key_paddock` still has no uniqueness constraint; duplicate scope rows are prevented app-side via `[...new Set(paddockIds)]` in `createKey`. Add the DB unique index (a migration) when multi-user lands, alongside the 5.7 concurrency work. (Spec §"Plan 5 / multi-tenant future".)
- **Cosmetic/polish (next Keys touch):** `keys-service.ts`'s `overrides: (data.overrides ?? null) as never` cast is heavier than needed (the `apiKey.overrides` jsonb insert type is already permissive — a narrower cast or none preserves type safety at that boundary); the 9d list shows a green "active" `StatusPill` for a key that is past its `expiresAt` but not revoked (`status` tracks only the revoked flag — the data-plane *will* reject the expired key; the UI conflates two distinct concepts, could show an "expired" state); the `rateMax` input allows `min="0"`, so a `max:0` per-key rate override (deny-all) can be constructed — same class as the deferred `.positive()`-on-`max` fence item, a service-layer validation choice. All Minor, none security-relevant.

### Carry-forward from Plan 5.5 whole-branch review (honor when expanding later plans)

Plan 5.5 shipped (branch `feat/metamodels-plan5.5`, merged to `main` at `8ab28a9`; plan-doc `7e196cd`): the three **read-only operator screens** over data Plans 1–5.4 produce. `usage-service.ts` (`usageMatrix` pivots key×paddock×5-`METER_DIMS`; `dailySeries` day-groups via `substring(period,1,10)`; `topKeys`; `sumDimSince`) + pure `lib/usage-range.ts` (`resolveRange(range,nowMs)` — **deterministic**, no `Date.now()` in the service; ranges are lexicographic `>=`/`<=` on the fixed-width `YYYY-MM-DDTHH` bucket); `audit-service.ts` (`listAudit` newest-first + action/actor filters; `auditFilterOptions` distinct+sorted; write-side `audit.ts` untouched). All six read fns org-scoped (`orgId = actor.orgId`) + `requireCapability('read')`, read-only. Screens: **10a Usage** (URL-`searchParams` filters, hand-authored pure-CSS `BarChart`, key×paddock×dim matrix), **10b Audit** (day-grouped, filterable, expandable `AuditRowItem`), **8a Dashboard** (4 **real-data** stat tiles — Flock health / Active paddocks / API keys / Tokens·24h). **Data-honesty:** the mock's "Requests 24h"/"Errors 24h" tiles were dropped (no request/error rollup exists) rather than fabricated. Client-safety extended cleanly: `config.ts` now re-exports `METER_DIMS`/`MeterDim` from `./enums.js` so the Usage client imports them from the client-safe `@metamodels/schema/config` subpath (stays within the allowlist guard — no barrel/`node:crypto` in the bundle). No migration, no new dependency. Control-plane 109 pass, root 176 pass/3 skip, `tsc -b` clean, `next build --webpack` clean with `/`, `/usage`, `/audit`. Whole-branch review: **no fix-now items** — all six read paths org-scoped, determinism/client-safety/serializable-boundary/data-honesty confirmed end-to-end.

- **Unify the "24h" window semantics (next Dashboard/Usage touch):** the Dashboard's "Tokens · 24h" / "Top keys · 24h" use a **rolling** 24h (`periodBucket(now - 24h)`), while the Usage screen's `range=24h` resolves to **today-to-date** (`<today>T00`) — internally consistent but an operator comparing the two sees different numbers. Align the labels (e.g. dashboard "today") or the windows; add a comment noting the intentional distinction so a future editor doesn't "fix" one into the other. (Whole-branch Minor.)
- **Request/error metering (deferred instrumentation — a data-plane pass, likely Plan 6):** the Dashboard substituted real "API keys"/"Tokens·24h" tiles for the mock's "Requests 24h"/"Errors 24h" because `usage_rollup` records meter dims, not per-request/per-error counters. If those tiles are wanted, the data-plane must roll up request/error counts; the `sumDimSince`/`topKeys` shape extends cleanly to new dims.
- **Cosmetic/polish (next Usage/Audit touch):** `topKeys` orders by `desc(sum)` with no secondary tiebreak → DB-dependent order on equal sums (add `apiKey.name` tiebreak for determinism); an unused `interface Opt` remains in `usage-client.tsx` (dead code, safe delete); `audit-client.tsx` computes Today/Yesterday day-group labels from a render-time `new Date()` → a theoretical hydration-label mismatch if a request straddles UTC midnight between SSR and hydration (sub-second, negligible; pass a server-computed `nowISO` prop to make it deterministic). All Minor, none security-relevant.

### Carry-forward from Plan 5.6 whole-branch review (honor when expanding later plans)

Plan 5.6 shipped (branch `feat/metamodels-plan5.6`, merged to `main` at `871026d`; plan-doc `0f2f3c6`): the **Plan-4 carry-forward** — stop the data-plane hitting Postgres for key/paddock/fence config on every proxied request. `CachingConfigStore` (`apps/data-plane/src/config/caching-config-store.ts`) is a TTL-memoizing decorator over `DrizzleConfigStore` — dual independent Maps, caches hits **and** negative (`null`) results, injected-`now` TTL (default 30 s, freshness = strict `expiresAt > now()`), **bounded** (`maxEntries` default 10 000 with FIFO eviction via `Map` insertion order), `invalidateAll()` flush-all. **Paired** with Redis pub/sub: shared channel/codec `CONFIG_INVALIDATE_CHANNEL='metamodels:config:invalidate'` + `{reason,at}` JSON in `@metamodels/schema/stream.ts` (both planes, same `encode`/`decodeConfigInvalidation`); the control-plane `config-publisher.ts` (`publishConfigInvalidation(reason)`, lazy ioredis singleton from `REDIS_URL`, **no-op without it**, always swallows errors) fires post-`revalidatePath` from all 10 mutating actions (flock/paddock/fence/key/template save+delete/status; read-only `dryRunTemplateAction` untouched); the data-plane subscriber (`config-invalidation-subscriber.ts`) flushes on any message via a **separate `redis.duplicate()` connection**. **Redis-gated:** caching + subscriber exist ONLY inside `server.ts`'s `if (redis)` branch — no Redis → plain uncached store → no staleness. Coarse flush-all invalidation (correct + cheap; config writes are rare) + short TTL backstops a missed message. Both new Redis clients (publisher singleton + duplicated subscriber conn) carry `.on('error', …)` handlers so an async connection error can't crash the process. `ioredis@5.4.2` added to control-plane (offline resolve — already in lockfile). **No migration.** Root 189 pass/3 skip, control-plane 112 pass, `tsc -b` clean, `next build --webpack` clean. Whole-branch review: **two Important fixed before merge** — (1) unbounded negative-cache growth = pre-auth memory DoS (`resolveKeyByHash` runs for every request with an auth header *before* rate-limiting; bounded caches close it) → **treat the cache bound as security-load-bearing, don't remove it**; (2) missing Redis `'error'` handlers (added).

- **Boot-level pub/sub smoke test (fast-follow — the one untested seam):** `startServer`'s Redis-branch wiring (wrap + `subscribeConfigInvalidation(redis.duplicate(), caching)`) and the action call-sites are integration-only, not unit-tested (matches the existing `RedisRateLimiter`/`RedisMeterSink` precedent). A boot test with a fake ioredis pub/sub asserting an operator action's publish reaches the subscriber's `invalidateAll()` would close it — pairs naturally with Plan 6's docker-compose + real-Redis integration.
- **`config-publisher` lazy-singleton path (Plan 6 real-Redis integration):** `defaultPublisher()`'s `REDIS_URL`→dynamic-`import('ioredis')`→memoize path is only exercised implicitly (the unit test injects a fake). A real-Redis integration test would cover it directly.
- **Cache-tuning knobs (only if profiling shows need):** `ttlMs` (30 s) and `maxEntries` (10 000) are fixed defaults, not config-driven. Coarse flush-all invalidation is deliberate (per-mutation cache-key mapping is a non-goal — config writes are rare). Revisit only under real load. **Never regress the `maxEntries` bound** (finding #1) — negative caching without it is a DoS vector.
- **Cosmetic (next `stream`/subscriber touch):** the 2nd `stream.js` import in `stream.test.ts` sits mid-file (hoisted, harmless); `store.invalidateAll()` sits inside the subscriber's malformed-payload-swallowing `try` (a store throw would be swallowed too — theoretical only, `Map.clear()` can't throw; move the flush outside the `try` if `Invalidatable` ever grows a throwing impl). Both Minor.

### Carry-forward from Plan 5.7a whole-branch review (honor when expanding Plan 5.7b + later)

Plan 5.7a shipped (branch `feat/metamodels-plan5.7a`, merged to `main` at `b3ec77d`; plan-doc `4db6f6b`): **Team / Users management** — the multi-user *mechanism* (the paid *unlock* is 5.7b). An admin invites teammates via **invite-then-accept** (`invites-service.ts#acceptInvite` is the ONLY `user`-creation path besides the seed, so `passwordHash` is never null; the invite token is surfaced once and only its SHA-256 hash is stored), assigns roles, and deactivates/reactivates operators (`users-service.ts`, with last-admin / self-lockout / actor-liveness / reactivate-seat guards). The seat invariant `count(active users) + count(pending invites) ≤ seatLimit` is enforced with `>=` inside each mutation's transaction; `seats.ts#getSeatLimit` returns `BASE_SEATS = 1` — **the single seam 5.7b rewrites** — so out of the box the seeded admin fills the one seat and inviting a 2nd operator is correctly gated. Screens: admin-only `/team` (server-guarded by `requireCapabilityOr403('user.manage')`, each action re-checks server-side) and PUBLIC `/accept-invite` (outside the `(app)` `requireUser` group; set password → create user → auto-login). Additive migration `0004` (`invite` table). Also folded in three Plan-5.1 auth fixes: `authorize.ts` `Role` bound to schema `USER_ROLES` with an exhaustive `satisfies` matrix; `verifyLogin` unknown-email dummy-scrypt timing-oracle fix; `requireCapabilityOr403` page guard re-introduced. Control-plane 112→138, root 189/3, `tsc -b` clean, `next build --webpack` clean. Whole-branch review: **no fix-now items**.

- **★★★ HARD REQUIREMENT FOR PLAN 5.7b (do NOT frame as "rewrite only `getSeatLimit`"):** the seat and last-admin guards in `inviteUser`, `setUserStatus` (reactivate), and `changeUserRole`/`setUserStatus` (`otherActiveAdmins`) use **count-then-mutate with no row lock** under Postgres READ COMMITTED. These are **provably unreachable while `BASE_SEATS = 1`** (the seeded admin permanently fills the one seat, so no org can reach 2 users/2 admins) — which is why 5.7a is safe — but they **go live the instant 5.7b raises the seat limit**. Concurrent races then possible: two simultaneous invites at the last free seat both insert (over-provision); two simultaneous last-two-admin deactivations both commit (**zero admins — org stranded**). 5.7b MUST add **per-org transactional locking** — `SELECT id FROM org WHERE id = :orgId FOR UPDATE`, or `pg_advisory_xact_lock(hashtext(orgId))` — at the top of each seat-consuming / admin-count transaction, before the count. This is a required 5.7b task, not optional.
- **Duplicate-invite guard (5.7b, when multi-seat lands):** `inviteUser` does not reject an email that already belongs to an active user or already has a pending invite — you can create a second pending invite for the same email (distinct token hash), each reserving a seat; it only fails later at accept-time via the global unique-email constraint. Add a pre-insert existence check when the seat limit exceeds 1 (harmless at base=1). Note `user.email` is **globally unique, not per-org** (inherited; it is also the backstop that makes concurrent double-accept of one token safe — the 2nd `insert(user)` violates unique-email and rolls back).
- **Cosmetic / consistency (any later Team touch):** the actor-liveness guard (non-active actor → `NotFoundError`) is on `setUserStatus` but not `changeUserRole` — cosmetic only, since `getCurrentActor` reloads the user and returns null for a non-active actor so neither is reachable by a deactivated actor via a real request; add the symmetric check for tidiness. `/team` + `/accept-invite` role pickers use a raw `<select>` (faithful mirror of `keys-client.tsx`, which also does) rather than the `ui/select.tsx` primitive — a codebase-wide cleanup for a later pass, both screens.

### Carry-forward from Plan 5.7b whole-branch review (honor in Plan 6 + later)

Plan 5.7b shipped (merged to `main` at `7330692`; plan-doc `2ef8bed`): **Lemon Squeezy license / entitlement** — the paid seat-limit *unlock* for the 5.7a Team mechanism. `seats.ts#getSeatLimit(db, orgId, nowMs)` now reads the org's one `entitlement` row (migration `0005`, `org_id` UNIQUE) and returns the licensed seat count while the license is `active` **or** within a 7-day offline-grace window, else `BASE_SEATS = 1`. An admin activates a key in `/settings → Upgrade`; the key is **AES-256-GCM encrypted at rest** (`license-crypto.ts`, keyed by a required `LICENSE_KEY_SECRET` env ≥16 chars) and never leaves the DB / reaches a client / is logged in plaintext (`getEntitlement` is a column-allowlisted no-key view; only server-internal `getDecryptedKey` decrypts, for re-validation). LS is reached behind an injected `fetchImpl` (`ls-client.ts`, no SDK, no new dep); `license-service.ts` orchestrates activate/deactivate/revalidate with the load-bearing offline-grace rule (a **thrown** transport error changes nothing; a **definitive** `valid:false` downgrades status but preserves the running grace clock). Re-validation is best-effort on login + on-demand from Settings (no scheduler yet). **The ★★★ 5.7a TOCTOU carry-forward is discharged:** `org-lock.ts#acquireOrgLock` (`SELECT id FROM org WHERE id = :orgId FOR UPDATE`) is the first in-tx statement of `inviteUser`/`changeUserRole`/`setUserStatus`, installed *before* the limit can exceed 1. Duplicate-invite guard added. Control-plane 138→166, root 189/3, `tsc -b` clean, `next build` clean. Whole-branch review: **no Critical; two Important fixed in-branch** (LS `fetch` given `AbortSignal.timeout(5000)` so a hanging LS endpoint can't stall login; `activateLicense` now gates on the confirming `validate`'s `valid` flag so an activated-but-invalid key gets no grant).

- **Plan 6 — prove the per-org lock under real concurrency:** `acquireOrgLock` is correct and wired first, but its tests only assert transparency/no-op (pglite is single-connection and cannot prove serialization). Add a Postgres-backed concurrency test (two simultaneous invites at the last free seat → exactly one succeeds; two simultaneous last-two-admin deactivations → org keeps ≥1 admin) once Plan 6's docker-compose brings up real Postgres.
- **Plan 6 — background re-validation scheduler:** re-validation is currently best-effort on login + on-demand only (deferred by design — needs infra). Add a periodic revalidate so an entitlement can expire without a login; the 7-day grace covers the gap until then.
- **Operator config (document in Plan 6 packaging):** `TIER_SEATS` (LS variant-name → seats map in `entitlement-service.ts`) and the `https://lemonsqueezy.com` storefront link in `settings-client.tsx` are placeholders the operator edits to match their LS store; `LICENSE_KEY_SECRET` must be a high-entropy env (single unsalted-sha256 KDF — plan-mandated, fine for an operator-controlled secret).
- **Cosmetic (any later touch):** two test files carry an unused `type TestDb` import (`entitlement-service.test.ts`, `license-service.test.ts`) — harmless (`noUnusedLocals` off); Settings forms have no in-flight submit-disable (faithful `keys-client.tsx` mirror — codebase-wide cleanup); `ls-client.ts#normalize` defaults an absent status to `'unknown'` (cosmetic in audit/UI).

### Carry-forward from Plan 6a whole-branch review (honor in Plan 6b/6c)

Plan 6a shipped (merged to `main` at `7356e2f`; plan-doc `2fc248a`): **Packaging & Compose** — the whole stack now runs from `docker compose up`. A single multi-target `docker/Dockerfile` builds the control-plane (`next build` → `next start`) and a shared **tsx-app** image (`ARG APP` ∈ {data-plane, worker, migrate}) that runs those apps straight from TS source (workspace `exports` resolve to `./src/*.ts`, so **no build step** — the image does a FULL `pnpm install --frozen-lockfile`, keeping the `tsx` devDep). `docker-compose.yml` wires `postgres`/`redis`/`migrate`/`control-plane`/`data-plane`/`worker` with health-gated ordering: DB+Redis healthy → one-shot `migrate` (`restart:"no"`) completes → the three apps start (each gates on `migrate: service_completed_successfully`). Migrations run via a **programmatic** `apps/migrate` (`drizzle-orm/postgres-js/migrator` against the frozen `packages/schema/drizzle` `0000–0005`) — `drizzle-kit` stays dev-only, never in a runtime image. New control-plane `GET /api/healthz` (liveness-only, no DB) backs the container healthcheck; healthchecks use Node global `fetch` (slim image has no curl). `.env.example` + a **drift-guard test** (`packages/schema/test/env-example.test.ts` scans first-party `process.env.X` reads, asserts each is documented) + `.dockerignore` + `scripts/smoke.sh` (compose up → migrate exit 0 → 3 health probes → teardown) + `docs/DEPLOY.md` + `README.md`. Verified LIVE against a Docker daemon: 4 image builds, migrate run, `compose config -q`, the full smoke, AND a real `run --rm control-plane pnpm seed` (`Seeded admin admin@example.com`). Root 189→192/3, control-plane 166→167, `tsc -b` clean. Whole-branch review: **no Critical outstanding; one Critical found + fixed in-branch** (compose `control-plane` service didn't pass `OPERATOR_EMAIL`/`OPERATOR_PASSWORD`, so the documented `pnpm seed` failed 100% — added both `${…}` vars to its `environment:` block; compose `.env` is interpolation-only, not injected into containers).

- **Plan 6b — CI hardening + real-Redis integration + the per-org-lock concurrency test** (all the "Plan 6" carry-forwards above now belong to 6b): the GitHub Actions supply-chain requirements below; the worker consumer-group `skipIf(REDIS_TEST_URL)` test on real Redis; the config pub/sub boot smoke; the `acquireOrgLock` Postgres concurrency test. Note the **typecheck-needs-build** gotcha (control-plane `tsc -b` needs `.next/types` from a prior `next build`/`next typegen`) — CI must build the control-plane before typechecking it. It is documented in `docs/DEPLOY.md`; 6b's workflow must enforce it.
- **Plan 6c — the LS re-validation scheduler** as its **own `apps/scheduler`** app (decided with Carmelo): a periodic revalidate so an entitlement can expire without a login (the 7-day grace covers the gap).
- **6a deferred Minors (reviewer-triaged defer-OK → 6b):** the env-drift regex `/process\.env\.[A-Z0-9_]+/` misses indirect/destructured reads (e.g. data-plane reads `PORT` via `loadServerConfig(env)`, not a literal — `.env.example` is complete today, but a future indirectly-read key would escape the guard); `SKIP_SEGMENTS` matches path segments off the ABSOLUTE path (pathological vacuous-pass only if the repo is checked out under a dir literally named `node_modules`/`.next`/`dist` — masks nothing today); `apps/migrate/package.json` omits the `version` field (harmless, private pkg); the Dockerfile `ARG APP` has no default (compose always passes it; a bare `--target tsx-app` build fails loud, not silent); images are ~950MB (deliberate non-goal — `pnpm deploy`-style pruning is a later optimization); data-plane `PORT` is effectively pinned to `8787` unless the compose port mapping AND the in-container healthcheck URL are changed together (now carries a clarifying comment).

### Carry-forward from Plan 6b whole-branch review (honor in Plan 6c + later)

Plan 6b shipped (branch `feat/metamodels-plan6b`, ff-merged to `main` at `9846fe9`; plan-doc `815f4ee`): **CI hardening + the real-server integration tests 6a's packaging enables.** Two vitest lanes now run in GitHub Actions against **`postgres:16` + `redis:7` service containers** with `DATABASE_URL`/`PG_TEST_URL`/`REDIS_TEST_URL` set, so every `skipIf` integration suite executes in CI (build-before-typecheck for the `.next/types` gotcha; a one-shot migrate step; a `build-smoke` job runs `scripts/smoke.sh` on the runner). New tests: a **real-Postgres harness** (`apps/control-plane/src/test/real-pg.ts` — `makeRealPgDb` on a `postgres({ max: 8 })` multi-connection pool + frozen migrations; gated by `PG_TEST_URL`), the **per-org-lock concurrency test** (`org-lock-concurrency.test.ts` — proves `acquireOrgLock`'s `SELECT … FOR UPDATE` serializes the seat race and the last-admin race; the 5.7a→5.7b carry-forward pglite couldn't verify), and the **config pub/sub smoke** (`apps/data-plane/test/config-pubsub.integration.test.ts` — real cross-connection `ioredis` publish→subscribe flushes `CachingConfigStore`; the 5.6 boot-seam carry-forward). Supply-chain: `zizmor.yml` (required check, `pipx run zizmor==1.28.0 --pedantic`) + `.github/CODEOWNERS` on `/.github/` + lockfile/root config; both actions pinned to full 40-char SHAs (`actions/checkout@11d5960a`, `actions/setup-node@49933ea5`), `permissions: contents: read`, no `id-token`, no `pull_request_target`, `--frozen-lockfile`, no dependency caching, `timeout-minutes` on both jobs. Verified: `tsc -b` clean; env-UNSET root **192 pass / 4 skip**, control-plane **167 pass / 3 skip**; env-SET all integration suites green (root 197/197, control-plane 170/170); full smoke re-ran green vs a live Docker daemon. **No new runtime dependency.** Whole-branch review: no Critical/Important; one plan self-contradiction found + fixed in-branch (the harness round-trip test was double-collected by both lanes — moved out of the `/test/` path to be single-lane).

- **★ CI has never actually RUN — first execution is on push.** The `.github/workflows/*.yml` were authored + statically validated (grep-gated: no `pull_request_target`, all actions genuine 40-hex SHAs; zizmor `--pedantic` confirmed a valid 1.28.0 flag), but there was **no git remote and no local Actions runner** (`act`/`actionlint`/`zizmor` not installed), so nothing was executed on CI. When a remote is added and the branch pushes, the **first CI run is the real gate** — watch for: the `zizmor` job failing on anything the static review missed; the control-plane lane's reliance on **`vitest` resolving from the hoisted workspace-root devDep** (not in `apps/control-plane/package.json` — fine under the current lockfile's hoisting, would break under a strict/isolated node-linker; add `vitest` to control-plane devDeps if it ever breaks); and the pub/sub test's **150ms fixed sleep before publish** (it does not await the SUBSCRIBE ack — a pathologically slow CI Redis could drop the single publish; harden by awaiting the subscribe round-trip if it flakes).
- **Operator must enable branch protection** — `CODEOWNERS` is inert until `main` requires the `test`/`build-smoke`/`zizmor` checks + "review from Code Owners" (documented in `docs/DEPLOY.md`). The v1 supply-chain posture isn't enforced until that setting is on.
- **Plan 6c — the LS re-validation scheduler** as its own **`apps/scheduler`** app (decided with Carmelo): a periodic revalidate so an entitlement can expire without a login (the 7-day grace covers the gap). The real-PG/real-Redis integration harnesses 6b added are available to it.
- **6b deferred Minors (non-blocking):** the plan's own Step-4 pin-check regex `@(v?[0-9]|main|master)` false-positives on genuine SHAs starting with a digit — a **verification-command** bug, not a shipped-file issue (a correct allowlist check is `grep -vE '@[0-9a-f]{40}'`); the DEPLOY.md CI overview omits the migrate step in one narrative sentence (cosmetic — fixed in the fix wave).

### Supply-chain / CI hardening (✅ IMPLEMENTED in Plan 6b — `9846fe9`)

Applied already (repo-wide, 2026-07-26): hardened `.npmrc` (`minimumReleaseAge=1440`, `blockExoticSubdeps=true`), Node floor bumped to `>=24` + `.nvmrc`. **Plan 6b's GitHub Actions honor these** (all authored, first CI run on push): no `pull_request_target`; every third-party action pinned to a full commit SHA (not a tag); **no** dependency caching (skipped entirely to minimize attack surface — stronger than `actions/cache/restore`); **no** `id-token` (nothing publishes in v1); `pnpm install --frozen-lockfile`; `zizmor` as a required workflow check; CODEOWNERS on `.github/` (+ lockfile/root config). Control-plane stays on `next@16.2.0` (≥16.2, avoids CVE-2025-66478) with security headers.

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
import { migrate } from 'drizzle-orm/pglite/migrator'
import { eq } from 'drizzle-orm'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, test } from 'vitest'
import * as schema from '../src/schema.js'

const { apiKey, fence, flock, org, paddock } = schema

let db: ReturnType<typeof drizzle<typeof schema>>

beforeAll(async () => {
  const client = new PGlite()
  db = drizzle(client, { schema })
  // Apply the real generated Drizzle migrations to the in-memory DB.
  const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../drizzle')
  await migrate(db, { migrationsFolder })
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

_(No hand-written DDL: the test applies the real migrations generated from `schema.ts` in Step 5, so there is a single source of truth for the schema.)_

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test schema`
Expected: FAIL — cannot resolve `../src/schema.js` (and no `./drizzle` migrations exist yet).

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

- [ ] **Step 5: Generate migrations, then run the test**

Run: `pnpm --filter @metamodels/schema db:generate`
Expected: a migration SQL file appears under `packages/schema/drizzle/` containing every table in `schema.ts`.

Run: `pnpm test schema`
Expected: PASS — the migrator applies `./drizzle` to the in-memory pglite DB, then both schema tests pass.

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
