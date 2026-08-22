# MetaModels v0.1 QoL — Design

**Status:** approved in brainstorming 2026-08-22. Ships as the **first release, `v0.1.0`**
(pre-1.0 semver — the software has never been released).

Two independent, file-disjoint quality-of-life features, plus the release plumbing that
turns the repo into something deployable on Portainer from a registry.

## Goals

1. **Ollama model picker.** Anywhere an operator enters a model name, offer the flock's real
   model list instead of blind free-text — while still allowing a model that isn't pulled
   yet, and never blocking fence edits when the upstream is down.
2. **Registry images + Portainer deploy.** Publish pre-built, versioned images to GHCR so a
   Portainer stack deploys MetaModels by *pulling* — `docker compose up` with no source
   checkout and no local build.

## Global Constraints

Copied from the repo's standing posture; every task inherits these.

- **Node** `>=24`; **pnpm** `11.9.0` (corepack-pinned); TypeScript strict; `tsc -b` clean.
- **No new runtime dependency** for Feature A. Feature B adds only CI-time GitHub Actions,
  each **pinned to a 40-char commit SHA** (matches existing `ci.yml` / `zizmor.yml`).
- **Supply-chain:** `.npmrc` `minimumReleaseAge=1440` + `blockExoticSubdeps=true` stay; no
  `pull_request_target`; least-privilege `permissions:` on every workflow.
- **Two test lanes:** root `pnpm test` (globs `packages/**/test/**` + `apps/**/test/**/*.test.ts`)
  and control-plane `vitest` (globs `src/**/*.test.ts`). New tests land in the correct lane;
  nothing is double-collected.
- **TDD throughout:** failing test first, minimal implementation, green, commit.
- **Data-plane enforcement path is not touched** by Feature A. The stored constraint shape
  (`allowedModels: string[]`) is unchanged, so there is **no migration**.

---

## Feature A — Ollama model picker in the fence

### A.1 What changes, and what deliberately does not

The **only** place an operator types a model name is the Fence editor's "Model allowlist"
(`apps/control-plane/src/app/(app)/paddocks/[id]/fence/fence-client.tsx:79`) — today a
comma-separated free-text `<Input>` whose value is saved as `allowedModels: string[]` in
`constraint_json`. The fence does an **exact-match** check at request time, so a typo blocks a
model with no feedback until a consumer 403s.

**Unchanged:** the saved value stays `allowedModels: string[]`. No schema, no migration, and
the data-plane guard (`packages/connectors/src/ollama/breed.ts` model check) is not touched.
We change only how the UI *produces* that array.

### A.2 Connector capability: `listModels`

Add an **optional** method to the breed interface (`packages/connectors/src/breed.ts`):

```ts
export interface ModelListResult {
  ok: boolean
  models: string[]      // e.g. ['qwen2.5-coder:0.5b', 'llama3.1:8b']; empty when ok:false
  detail?: string       // failure reason for the UI
}

export interface Breed<C = unknown> {
  // ...existing members...
  health(flock: FlockRef): Promise<HealthStatus>
  listModels?(flock: FlockRef): Promise<ModelListResult>   // NEW, optional
}
```

- **Ollama** (`packages/connectors/src/ollama/breed.ts`) implements it: `GET {baseUrl}/api/tags`,
  parse `.models[].name` into a sorted, de-duplicated `string[]`. On any fetch/parse error
  return `{ ok: false, models: [], detail }` — never throw. Reuses the same egress path and
  `upstreamAuth`/`tlsTrust` handling that `health()` already uses; factor the fetch/header
  construction so the two share it rather than duplicating.
- **ComfyUI** does **not** implement `listModels` (its models live inside graph JSON, not as a
  flat name list). A caller must treat "method absent" as "unsupported" and the fence UI for a
  ComfyUI paddock keeps its current behavior.

### A.3 Server action: `listFlockModelsAction`

New action beside the existing `testConnectionAction`
(`apps/control-plane/src/app/(app)/flocks/actions.ts`, or a fence-local `actions.ts` —
implementer's call, keep it next to whichever page consumes it):

```ts
export async function listFlockModelsAction(
  flockId: string,
): Promise<ModelListResult>
```

- `requireUser()` + `authorize(actor, 'resource.read')` — same read gate as viewing the fence.
- Load the flock **org-scoped** via `listFlocks(db, actor)` then `find(id)` (the fence page
  already does exactly this), so a caller can never enumerate another org's flock. Return
  `{ ok:false, models:[], detail:'not found' }` if absent.
- Look up the breed in the registry; if it has no `listModels`, return
  `{ ok:false, models:[], detail:'unsupported' }`.
- Otherwise call `breed.listModels({ baseUrl, upstreamAuth, tlsTrust })` and return it.

### A.4 Fence UI

Thread `flockId` into `FenceClient` props (the page already has it via `paddock.flockId`).

Replace the single free-text input with a **model allowlist control** that:

- On mount (and via a **Refresh** button) calls `listFlockModelsAction(flockId)`.
- **Success:** renders a checklist of the returned models, each pre-checked if present in the
  current `allowedModels`. Below it, an "add another" text field appends a **manual chip** for
  a name not in the list (so a not-yet-pulled model can be pre-authorized). Any saved
  `allowedModels` value not in the live list renders as a manual chip too, so nothing is lost.
  Show a quiet "↻ refreshed from `<flockName>`" affordance.
- **Failure / unsupported / loading-error:** collapse to the **current** comma-separated
  free-text input, seeded with the existing value, plus a muted note
  ("couldn't reach `<flockName>` — enter model names manually"). **Editing the fence is never
  blocked by an unreachable upstream.**
- **Empty allowlist still means "any model"** — preserve today's semantics exactly; the
  placeholder/help text must keep saying so.

The control serializes back to the same hidden `models` form field (comma-joined) the save
action already parses, so `fences-service` and the constraint schema are untouched.

### A.5 Testing (Feature A)

- **Connector unit** (`packages/connectors/test/`): `ollamaBreed.listModels` parses a sample
  `/api/tags` body into sorted names; returns `{ok:false}` (not a throw) on a network error
  and on malformed JSON, via an injected `fetchImpl`.
- **Action unit** (control-plane lane): org-scoping (foreign flock id → not found), the
  unsupported-breed path, and pass-through of a stubbed `listModels`.
- **Model-allowlist control unit:** given live models + a saved value, the right boxes are
  checked and an out-of-list saved value appears as a manual chip; the serialized output
  round-trips; the failure branch renders the free-text fallback.
- The **e2e walkthrough** (`apps/e2e`) step 4 is updated to drive the new control (check a
  model from the live list) instead of typing into the free-text box — proving it against real
  Ollama. Keep a path that still works if a future run needs the manual entry.

---

## Feature B — GHCR images + Portainer deploy

### B.1 Dockerfile: a registry-friendly `runtime` stage

The current `tsx-app` target bakes `ARG APP` into its WORKDIR, so it can't be one reusable
image. Add a generic stage (keep all existing targets so the dev build-from-source compose is
untouched):

```dockerfile
# --- runtime: all workspace TS source + tsx; one image, run any app via compose command ---
FROM deps AS runtime
WORKDIR /app
ENV NODE_ENV=production
# No baked CMD/APP — the deploy compose sets working_dir + command per service.
```

Result: **two publishable images.**

- `control-plane` (existing target: Next build → `next start`; also runs the scheduler via a
  command override — the scheduler entrypoint lives in `apps/control-plane/bin/scheduler.ts`).
- `runtime` (new: runs `data-plane`, `worker`, and the one-shot `migrate` via per-service
  command).

### B.2 Publish workflow: `.github/workflows/release.yml`

New workflow, same hardening conventions as `ci.yml`/`zizmor.yml`.

- **Triggers:** `push: tags: ['v*']` and `push: branches: [main]`.
- **Permissions (job-scoped, least privilege):** `contents: read`, `packages: write`,
  `id-token: write`, `attestations: write`. No `pull_request_target`.
- **Auth:** `docker/login-action` to `ghcr.io` with the built-in `GITHUB_TOKEN` — **no new
  secret**.
- **Tags** via `docker/metadata-action`: semver (`type=semver,pattern={{version}}` and
  `{{major}}.{{minor}}`) on a tag; `type=raw,value=edge` on `main`; `type=sha`. `latest` on a
  tag push. Because releases are `v0.x`, `latest` simply tracks the newest tag.
- **Build/push** via `docker/build-push-action`, `platforms: linux/amd64`, once per target
  (`control-plane`, `runtime`), with **`provenance: true`** and build-provenance
  **attestations** (`actions/attest-build-provenance`) — native, free with the OIDC token.
- All third-party actions **SHA-pinned** (40-char). A first push builds+pushes both images and
  their attestations; **cosign keyless signing is deferred to the `/security-review` pass** as
  an explicit decision, not silently omitted.
- Concurrency group + `timeout-minutes`, matching the other workflows.

Images publish to `ghcr.io/carmelosantana/metamodels-control-plane` and
`…/metamodels-runtime`, **public** (so Portainer pulls with no auth).

### B.3 `docker-compose.deploy.yml`

New, self-contained file at repo root — the one thing an operator pastes into a Portainer
stack. References images, never `build:`:

- `control-plane`: `image: ghcr.io/carmelosantana/metamodels-control-plane:${TAG:-latest}`.
- `data-plane` / `worker`: `image: …/metamodels-runtime:${TAG:-latest}` with
  `working_dir: /app/apps/<svc>` + `command: [pnpm, start]`.
- `migrate` (one-shot): runtime image, `working_dir: /app/apps/migrate`, `command: [pnpm, start]`,
  `service_completed_successfully`-gated as today.
- `scheduler`: control-plane image, `command: [pnpm, scheduler]`.
- `postgres` / `redis`: same pinned images as `ci.yml`.
- **Every `environment:` block lists its vars explicitly** (the Plan-6a interpolation-only
  Critical — a Portainer stack injects stack env for both interpolation and containers, but the
  file must not rely on that for the app vars).
- Host ports via `CONTROL_PLANE_PORT` / `DATA_PLANE_PORT` (already conventions).
- Health-gated `depends_on` ordering preserved from `docker-compose.yml`.

`${TAG}` lets an operator pin `v0.1.0` (recommended) or track `latest`/`edge`.

### B.4 Docs & release process

- **`docs/DEPLOY.md`:** add "Deploy with Portainer (pre-built images)" — create a stack, paste
  `docker-compose.deploy.yml`, set env in the Portainer UI, pin `TAG=v0.1.0`, deploy; note the
  seed step (`pnpm seed`) runs once via a one-off container/exec. Keep the existing
  build-from-source section for local dev.
- **Release process** (documented in DEPLOY.md or `docs/RELEASING.md`): bump versions if we
  track them, `git tag v0.1.0`, push the tag → workflow publishes → Portainer pulls. First
  release is **`v0.1.0`**.

### B.5 Testing (Feature B)

- **Workflow lint:** `zizmor --pedantic` stays green on the new `release.yml` (run in the
  existing zizmor job / locally via the Docker one-liner).
- **`docker-compose.deploy.yml` validity:** `docker compose -f docker-compose.deploy.yml config
  -q` parses; a smoke variant of `scripts/smoke.sh` (or a note) proves the referenced services
  and env line up. Since images won't exist until the first tag, the compose smoke can point at
  locally-built images tagged to match, or run after the first `edge` publish.
- **Env-drift guard** (`packages/schema/test/env-example.test.ts`) stays green — any new env
  key is either documented in `.env.example` or excluded if test-only.

---

## Out of scope (named, so they're choices not omissions)

- ComfyUI model selection (models live in graphs; the template editor already owns that).
- Model pickers anywhere other than the fence allowlist (that's the only model-entry surface).
- Multi-arch images (amd64 only; add arm64 later if an ARM host appears).
- Cosign image signing (raised in `/security-review`, decided there).
- A private/self-hosted registry (GHCR public is the target).

## Execution & release plan

1. **One feature branch, two independent task groups** (A then B) via
   `superpowers:subagent-driven-development`, **opus both roles**, per-task review + one
   whole-branch review, **ff-merge to `main`** — the standing workflow.
2. **After the plan is written and committed, assess context size and `/compact` if warranted**
   before the autonomous run (the plan on disk is the source of truth either way).
3. **Lock-down gate on the finished branch, in order:** `/security-review` →
   `/engineering:code-review` → `/supply-chain-risk-mitigation`. The publish workflow is
   squarely supply-chain territory (registry auth, workflow permissions, attestations, the
   cosign decision).
4. **Cut `v0.1.0`** once the gate is clean — the tag fires `release.yml` and publishes the
   first images.

**Standing reminder (operator-only):** rotate the GitHub PAT(s) in `~/.bash_history`
(security-posture P0).
