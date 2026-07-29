# MetaModels Plan 6a — Packaging & Compose Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the whole MetaModels stack runnable with one `docker compose up` — a Postgres, a Redis, a one-shot database-migration step, and the three application services (control-plane, data-plane, worker) — plus the env contract, a health endpoint the control-plane is missing, and the deploy/operator documentation.

**Architecture:** A single multi-target `docker/Dockerfile` builds two image kinds: the control-plane (a `next build` → `next start` multi-stage image) and a shared "tsx-app" image (parametrised by `ARG APP`) that runs the data-plane, worker, and a new one-shot `apps/migrate` service straight from TypeScript via `tsx` (the workspace packages resolve to `./src/*.ts`, so no compile step is needed). `docker-compose.yml` wires them with health-gated `depends_on` ordering: Postgres+Redis become healthy → `migrate` runs the drizzle migrations to completion → the three apps start. Migrations are applied by a **programmatic** `drizzle-orm/postgres-js/migrator` runner (not `drizzle-kit`, which stays a dev-only tool and never enters a runtime image).

**Tech Stack:** Docker + Docker Compose · `node:24-bookworm-slim` base · pnpm 11.9.0 via corepack · Postgres 16 · Redis 7 · TypeScript ESM run by `tsx` · Next.js 16.2.0 (`next build --webpack` → `next start`) · Drizzle programmatic migrator · Vitest + pglite for the unit-testable pieces.

## Global Constraints

- **Node `>=24`; ESM only.** Base image `node:24-bookworm-slim`. pnpm is `11.9.0`, activated in-image via `corepack prepare pnpm@11.9.0 --activate` (there is no `packageManager` field to read; pin this version explicitly).
- **Workspace packages resolve to source.** `@metamodels/schema` and `@metamodels/connectors` `exports` point at `./src/*.ts` (verified: `schema` → `./src/index.ts`, `./config`, `./graph`; `connectors` → `./src/index.ts`). **The data-plane / worker / migrate images therefore need NO build step** — `tsx` reads the TS source directly. Do not add a `tsc` build for them.
- **`tsx` is a devDependency** of every app (`^4.19.0`). The tsx-app image installs with a **full** `pnpm install --frozen-lockfile` (NOT `--prod`, which would drop `tsx`). Image size is a non-goal for a self-hosted single-operator deploy; simplicity wins. (`pnpm deploy`-style pruning is a documented later optimization, not this plan.)
- **Migrations via the programmatic migrator only.** Apply `packages/schema/drizzle/*.sql` with `import { migrate } from 'drizzle-orm/postgres-js/migrator'` (verified resolvable + exports a `migrate` function). **`drizzle-kit` MUST NOT be invoked in any runtime image or the compose `migrate` service** — it is a dev tool and pulling it at runtime fights the `.npmrc` 24h publish-quarantine. The migrations folder is `packages/schema/drizzle` (frozen `0000`–`0005`; this plan adds none).
- **No new runtime dependency.** Everything needed (`postgres`, `drizzle-orm`, `ioredis`, `tsx`, `next`, `react`) already exists. The only new npm manifests are `apps/migrate/package.json` (deps drawn from the existing set) — no new package is downloaded.
- **Health/readiness endpoints already exist on the data-plane** (`app.ts`: `GET /healthz` → `{status:'ok'}`; `GET /readyz` → db `select 1` + optional redis ping, 503 when not ready). The **control-plane has none** — this plan adds `GET /api/healthz` for its compose healthcheck. Healthchecks use Node's global `fetch` (`node -e …`), NOT `curl` (slim image has no curl).
- **Env matrix (exact keys the code reads — put every non-test one in `.env.example`):** `DATABASE_URL`, `REDIS_URL`, `PORT` (data-plane, default `8787`), `SESSION_SECRET` (control-plane, ≥16 chars), `LICENSE_KEY_SECRET` (control-plane, ≥16 chars), `OPERATOR_EMAIL` + `OPERATOR_PASSWORD` (control-plane seed), `WORKER_NAME` (worker, optional). Test-only `REDIS_TEST_URL` and always-optional `NODE_ENV` are **excluded** from `.env.example`.
- **Compose service names (exact):** `postgres`, `redis`, `migrate`, `control-plane`, `data-plane`, `worker`.
- **`depends_on` ordering:** apps wait on `postgres`/`redis` `condition: service_healthy` AND `migrate` `condition: service_completed_successfully`. `migrate` waits on `postgres: service_healthy`. `migrate` has `restart: "no"`.
- **Determinism / seams unchanged.** This plan is packaging only — it changes NO service logic. The one behavioral addition (control-plane `/api/healthz`) is liveness-only (no DB), so it needs no injected clock or DB handle.
- **Docker steps require a Docker daemon.** Tasks 4–6 (`docker build`, `docker compose config`, the smoke script) cannot run where no Docker daemon is available; the implementer runs them locally and records the output. The unit-testable pieces (Tasks 1–3) and the docs (Task 7) do not need Docker.
- **Test lanes (keep green):** root `pnpm test` (baseline **189 pass / 3 skip** → **+2** = 191/3 after Tasks 1 & 3), control-plane `pnpm --filter @metamodels/control-plane exec vitest run` (baseline **166 pass** → **+1** = 167 after Task 2), workspace typecheck `pnpm -w exec tsc -b`. (Two pre-existing scrypt tests can time out under CPU contention — re-run the control-plane lane with `--testTimeout=30000`.)
- **Base-image pinning (supply-chain):** the Dockerfile/compose use the `node:24-bookworm-slim`, `postgres:16-bookworm`, `redis:7-bookworm` tags; add a comment that production should pin each by `@sha256:` digest (digest-pinning enforcement is a Plan 6b/CI concern, not blocking here).
- **Git identity:** `Carmelo Santana <me@carmelosantana.com>`. Branch: `feat/metamodels-plan6a`.

---

## File Structure

```
.dockerignore                                        # CREATE: keep node_modules/.next/dist/.git/.superpowers out of build context
.env.example                                         # CREATE: every non-test env key + comments
docker/
  Dockerfile                                         # CREATE: multi-target — base→deps→(control-plane | tsx-app ARG APP)
docker-compose.yml                                   # CREATE: postgres, redis, migrate, control-plane, data-plane, worker
apps/migrate/
  package.json                                       # CREATE: one-shot migrator app (postgres, drizzle-orm, @metamodels/schema, tsx)
  tsconfig.json                                      # CREATE: mirrors apps/worker/tsconfig.json
  src/index.ts                                       # CREATE: loadDatabaseUrl + runMigrations + direct-exec guard
  test/migrate.test.ts                               # CREATE: loadDatabaseUrl validation (root lane)
apps/control-plane/src/app/api/healthz/
  route.ts                                           # CREATE: GET → { status: 'ok' } (liveness)
  route.test.ts                                      # CREATE: co-located control-plane-lane test
packages/schema/test/env-example.test.ts             # CREATE: env-drift guard (root lane) — every process.env key is in .env.example
scripts/smoke.sh                                      # CREATE: compose up → migrate exits 0 → health endpoints 200 → down
docs/DEPLOY.md                                        # CREATE: quickstart, env, seed, operator config, trusted-proxy + typecheck notes
README.md                                             # CREATE (or MODIFY if present): top-level quickstart pointing at DEPLOY.md
```

**Decisions already made (surfaced to Carmelo, applied here):**
1. **Split:** this is Plan **6a** (packaging & compose) of a 6a/6b/6c split. 6b = CI hardening + real-Redis integration + the per-org-lock concurrency test; 6c = the LS revalidation scheduler (`apps/scheduler`). Neither is in scope here.
2. **tsx-at-runtime** for data-plane/worker/migrate images (no compile step; matches current npm scripts and the source-resolving package `exports`).
3. **Full install** (not `--prod`) in the tsx image so `tsx` (a devDep) is present.
4. **Programmatic migrator** in a one-shot `apps/migrate` service — keeps `drizzle-kit` dev-only and out of runtime images.

---

### Task 1: Env contract — `.env.example` + `.dockerignore` + a drift-guard test

Bundle the env contract with a test that fails if any env key the code reads is missing from `.env.example`, so the two never drift.

**Files:**
- Create: `packages/schema/test/env-example.test.ts` (root lane — `packages/**/test/**` glob)
- Create: `.env.example`
- Create: `.dockerignore`

**Interfaces:**
- Produces: `.env.example` at repo root — the single source operators copy to `.env`. No code imports it; the test enforces completeness.

- [ ] **Step 1: Write the failing test**

Create `packages/schema/test/env-example.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

// packages/schema/test/ -> repo root is three levels up.
const ROOT = fileURLToPath(new URL('../../..', import.meta.url))

// Env keys that are intentionally NOT in .env.example: test-only or framework-provided.
const EXCLUDED = new Set(['REDIS_TEST_URL', 'NODE_ENV'])

function tsFilesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    if (!/\.tsx?$/.test(entry.name)) continue
    // Dirent.parentPath is available on Node >=20.12 (we require >=24).
    out.push(join(entry.parentPath, entry.name))
  }
  return out
}

function envKeysUsedInSource(): Set<string> {
  const keys = new Set<string>()
  for (const root of ['apps', 'packages']) {
    for (const file of tsFilesUnder(join(ROOT, root))) {
      const src = readFileSync(file, 'utf8')
      for (const m of src.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
        if (!EXCLUDED.has(m[1])) keys.add(m[1])
      }
    }
  }
  return keys
}

describe('.env.example completeness', () => {
  test('every process.env key the code reads is documented in .env.example', () => {
    const example = readFileSync(join(ROOT, '.env.example'), 'utf8')
    const documented = new Set(
      example
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .map((l) => l.split('=')[0]),
    )
    const used = envKeysUsedInSource()
    const missing = [...used].filter((k) => !documented.has(k)).sort()
    expect(missing, `.env.example is missing keys: ${missing.join(', ')}`).toEqual([])
  })
})
```

- [ ] **Step 2: Run it — expect fail**

Run: `pnpm --filter @metamodels/schema exec vitest run test/env-example.test.ts`
Expected: FAIL — `ENOENT` opening `.env.example` (file does not exist yet).

- [ ] **Step 3: Create `.env.example`**

Create `.env.example` at the repo root:
```bash
# MetaModels environment. Copy to `.env` and fill in. `docker compose` reads `.env` automatically.

# --- Database (all services) ---
DATABASE_URL=postgres://metamodels:metamodels@postgres:5432/metamodels

# --- Redis (data-plane optional; worker requires it) ---
REDIS_URL=redis://redis:6379

# --- Data-plane HTTP port ---
PORT=8787

# --- Control-plane secrets (each >= 16 chars; generate with: openssl rand -hex 32) ---
SESSION_SECRET=change-me-to-a-long-random-string
LICENSE_KEY_SECRET=change-me-to-another-long-random-string

# --- First-run operator (used by `pnpm seed` in the control-plane container) ---
OPERATOR_EMAIL=admin@example.com
OPERATOR_PASSWORD=change-me

# --- Worker consumer name (optional; defaults to worker-<pid>) ---
WORKER_NAME=worker-1
```

- [ ] **Step 4: Create `.dockerignore`**

Create `.dockerignore` at the repo root:
```
node_modules
**/node_modules
.git
.next
**/.next
dist
**/dist
.superpowers
.env
*.log
```

- [ ] **Step 5: Run it — expect pass; both lanes**

Run: `pnpm --filter @metamodels/schema exec vitest run test/env-example.test.ts` → PASS (1 test).
Run: `pnpm test` → root **191 pass / 3 skip** (baseline 189 + this 1 = 190... recount: this adds exactly 1 root-lane test → **190 pass / 3 skip**). Record the actual number.

- [ ] **Step 6: Commit**

```bash
git add .env.example .dockerignore packages/schema/test/env-example.test.ts
git commit -m "feat(packaging): .env.example + .dockerignore + env-drift guard test"
```

---

### Task 2: Control-plane `GET /api/healthz` liveness route

The compose control-plane healthcheck needs an endpoint; the app has none. Add a liveness route (no DB — liveness, not readiness).

**Files:**
- Create: `apps/control-plane/src/app/api/healthz/route.ts`
- Create: `apps/control-plane/src/app/api/healthz/route.test.ts` (control-plane lane — `src/**/*.test.ts`)

**Interfaces:**
- Produces: `GET(): Response` at `/api/healthz` → `200 { status: 'ok' }`.

- [ ] **Step 1: Write the failing test**

Create `apps/control-plane/src/app/api/healthz/route.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import { GET } from './route'

describe('GET /api/healthz', () => {
  test('returns 200 with a liveness body', async () => {
    const res = GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })
})
```

- [ ] **Step 2: Run it — expect fail**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/app/api/healthz/route.test.ts`
Expected: FAIL — `Cannot find module './route'`.

- [ ] **Step 3: Implement the route**

Create `apps/control-plane/src/app/api/healthz/route.ts`:
```ts
// Liveness probe for the container healthcheck. Intentionally does NOT touch the DB —
// it answers "is the Next server up?", not "is every dependency ready?". Keep it dependency-free
// so a slow/unavailable Postgres never flaps the control-plane's own health status.
export function GET(): Response {
  return Response.json({ status: 'ok' })
}
```

- [ ] **Step 4: Run it — expect pass; typecheck**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/app/api/healthz/route.test.ts` → PASS (1 test).
Run: `pnpm -w exec tsc -b` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/app/api/healthz/route.ts apps/control-plane/src/app/api/healthz/route.test.ts
git commit -m "feat(control-plane): GET /api/healthz liveness route for the container healthcheck"
```

---

### Task 3: `apps/migrate` — one-shot programmatic migration runner

A tiny service that applies the drizzle migrations against `DATABASE_URL` and exits. It is the compose `migrate` step and the only thing that touches DDL in production.

**Files:**
- Create: `apps/migrate/package.json`
- Create: `apps/migrate/tsconfig.json`
- Create: `apps/migrate/src/index.ts`
- Create: `apps/migrate/test/migrate.test.ts` (root lane — `apps/**/test/**` glob)

**Interfaces:**
- Consumes: `drizzle-orm/postgres-js/migrator#migrate` (verified resolvable); the `postgres` driver; `packages/schema/drizzle/*.sql`.
- Produces:
  - `loadDatabaseUrl(env: Record<string, string | undefined>): string` — returns `env.DATABASE_URL`, throws `'DATABASE_URL is required'` when unset.
  - `runMigrations(databaseUrl: string): Promise<void>` — opens a single-connection `postgres` client, runs `migrate(db, { migrationsFolder })`, closes the client in a `finally`.

- [ ] **Step 1: Write the failing test**

Create `apps/migrate/test/migrate.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import { loadDatabaseUrl } from '../src/index'

describe('loadDatabaseUrl', () => {
  test('returns DATABASE_URL when set', () => {
    expect(loadDatabaseUrl({ DATABASE_URL: 'postgres://x/y' })).toBe('postgres://x/y')
  })

  test('throws when DATABASE_URL is missing', () => {
    expect(() => loadDatabaseUrl({})).toThrow('DATABASE_URL is required')
  })
})
```
(`runMigrations` needs a real Postgres, so it is proven by the compose smoke in Task 6 / the Plan 6b real-Postgres integration — not unit-tested here. Do not mock the migrator to fake coverage.)

- [ ] **Step 2: Run it — expect fail**

Run: `pnpm --filter @metamodels/migrate exec vitest run test/migrate.test.ts`
Expected: FAIL — the package/module does not exist yet (`Cannot find module '../src/index'`, or the filter matches no project).

- [ ] **Step 3: Create the package manifest + tsconfig**

Create `apps/migrate/package.json` (mirror `apps/worker/package.json`, add `postgres`):
```json
{
  "name": "@metamodels/migrate",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "start": "tsx src/index.ts" },
  "dependencies": {
    "@metamodels/schema": "workspace:*",
    "drizzle-orm": "^0.45.2",
    "postgres": "^3.4.0"
  },
  "devDependencies": {
    "tsx": "^4.19.0"
  }
}
```

Create `apps/migrate/tsconfig.json` — copy `apps/worker/tsconfig.json` verbatim (same compiler options / references; read it first and reproduce it exactly so the composite build graph stays consistent).

Then install so the new workspace package is linked and the lockfile updates:
```bash
pnpm install
```

- [ ] **Step 4: Implement `apps/migrate/src/index.ts`**

```ts
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'

// apps/migrate/src/ -> repo root is three levels up, then the frozen drizzle folder.
const migrationsFolder = fileURLToPath(new URL('../../../packages/schema/drizzle', import.meta.url))

export function loadDatabaseUrl(env: Record<string, string | undefined>): string {
  const url = env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required')
  return url
}

export async function runMigrations(databaseUrl: string): Promise<void> {
  const client = postgres(databaseUrl, { max: 1 })
  try {
    await migrate(drizzle(client), { migrationsFolder })
  } finally {
    await client.end()
  }
}

// Only run when executed directly (tsx src/index.ts), not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith('index.ts')) {
  runMigrations(loadDatabaseUrl(process.env))
    .then(() => {
      // eslint-disable-next-line no-console
      console.log('metamodels: migrations applied')
      process.exit(0)
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('metamodels: migration failed', err)
      process.exit(1)
    })
}
```

- [ ] **Step 5: Run it — expect pass; typecheck; root lane**

Run: `pnpm --filter @metamodels/migrate exec vitest run test/migrate.test.ts` → PASS (2 tests).
Run: `pnpm -w exec tsc -b` → clean (the new `apps/migrate` references resolve).
Run: `pnpm test` → root count = prior + 2 (**192 / 3 skip** if Task 1 landed 190). Record the actual number.

- [ ] **Step 6: Commit**

```bash
git add apps/migrate pnpm-lock.yaml
git commit -m "feat(migrate): one-shot programmatic drizzle migration runner (apps/migrate)"
```

---

### Task 4: `docker/Dockerfile` — multi-target images (control-plane + tsx-app)

One Dockerfile, three named stages plus two build targets. `deps` installs the whole workspace once; `control-plane` builds and serves Next; `tsx-app` runs any of data-plane/worker/migrate from source.

**Files:**
- Create: `docker/Dockerfile`

**Interfaces:**
- Produces: build target `control-plane` (runs `next start` on 3000) and build target `tsx-app` with `ARG APP` ∈ {`data-plane`, `worker`, `migrate`} (runs that app's `pnpm start`).

- [ ] **Step 1: Write the Dockerfile**

Create `docker/Dockerfile`:
```dockerfile
# syntax=docker/dockerfile:1

# Pin by @sha256: digest in production. Tags used here for readability.
FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
WORKDIR /app

# --- deps: install the whole workspace once (full install; tsx is a devDep the tsx apps need) ---
FROM base AS deps
COPY . .
RUN pnpm install --frozen-lockfile

# --- control-plane: build then serve with next start ---
FROM deps AS control-plane-build
RUN pnpm --filter @metamodels/control-plane build

FROM control-plane-build AS control-plane
WORKDIR /app/apps/control-plane
ENV NODE_ENV=production
EXPOSE 3000
CMD ["pnpm", "start"]

# --- tsx-app: run data-plane / worker / migrate straight from TS source ---
FROM deps AS tsx-app
ARG APP
WORKDIR /app/apps/${APP}
CMD ["pnpm", "start"]
```

- [ ] **Step 2: Build the control-plane image (requires Docker)**

Run: `docker build -f docker/Dockerfile --target control-plane -t metamodels/control-plane .`
Expected: builds successfully (the `next build --webpack` runs inside `control-plane-build`).

- [ ] **Step 3: Build each tsx-app image (requires Docker)**

Run:
```bash
docker build -f docker/Dockerfile --target tsx-app --build-arg APP=data-plane -t metamodels/data-plane .
docker build -f docker/Dockerfile --target tsx-app --build-arg APP=worker -t metamodels/worker .
docker build -f docker/Dockerfile --target tsx-app --build-arg APP=migrate -t metamodels/migrate .
```
Expected: all three build successfully.

- [ ] **Step 4: Smoke a tsx image imports its app (requires Docker)**

Run: `docker run --rm metamodels/migrate node -e "process.exit(0)"`
Expected: exits 0 (image is runnable; the full migrate run is exercised in Task 6 against a real Postgres).

(If no Docker daemon is available in this environment, record that Steps 2–4 were deferred to a local/Docker-capable run and proceed — the Dockerfile is still committed for review.)

- [ ] **Step 5: Commit**

```bash
git add docker/Dockerfile
git commit -m "feat(packaging): multi-target Dockerfile (control-plane build+start; tsx-app for data-plane/worker/migrate)"
```

---

### Task 5: `docker-compose.yml` — the full stack

**Files:**
- Create: `docker-compose.yml`

**Interfaces:**
- Consumes: the Task 4 build targets; the Task 2 `/api/healthz` route; the data-plane `/healthz`; the Task 3 `migrate` service.
- Produces: `docker compose up` bringing up `postgres`, `redis`, `migrate` (one-shot), `control-plane`, `data-plane`, `worker` in dependency order.

- [ ] **Step 1: Write the compose file**

Create `docker-compose.yml`:
```yaml
# Copy .env.example to .env first; compose reads .env automatically.
services:
  postgres:
    image: postgres:16-bookworm # pin by @sha256 in production
    environment:
      POSTGRES_USER: metamodels
      POSTGRES_PASSWORD: metamodels
      POSTGRES_DB: metamodels
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U metamodels -d metamodels"]
      interval: 5s
      timeout: 5s
      retries: 10

  redis:
    image: redis:7-bookworm # pin by @sha256 in production
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 10

  migrate:
    build:
      context: .
      dockerfile: docker/Dockerfile
      target: tsx-app
      args:
        APP: migrate
    environment:
      DATABASE_URL: ${DATABASE_URL}
    depends_on:
      postgres:
        condition: service_healthy
    restart: "no"

  control-plane:
    build:
      context: .
      dockerfile: docker/Dockerfile
      target: control-plane
    environment:
      DATABASE_URL: ${DATABASE_URL}
      REDIS_URL: ${REDIS_URL}
      SESSION_SECRET: ${SESSION_SECRET}
      LICENSE_KEY_SECRET: ${LICENSE_KEY_SECRET}
      NODE_ENV: production
    ports:
      - "3000:3000"
    depends_on:
      postgres:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3000/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 5

  data-plane:
    build:
      context: .
      dockerfile: docker/Dockerfile
      target: tsx-app
      args:
        APP: data-plane
    environment:
      DATABASE_URL: ${DATABASE_URL}
      REDIS_URL: ${REDIS_URL}
      PORT: ${PORT}
    ports:
      - "8787:8787"
    # So the data-plane can reach an Ollama/ComfyUI running on the host (set the Flock URL
    # to http://host.docker.internal:11434 etc. in the control-plane UI).
    extra_hosts:
      - "host.docker.internal:host-gateway"
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 5

  worker:
    build:
      context: .
      dockerfile: docker/Dockerfile
      target: tsx-app
      args:
        APP: worker
    environment:
      DATABASE_URL: ${DATABASE_URL}
      REDIS_URL: ${REDIS_URL}
      WORKER_NAME: ${WORKER_NAME}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully

volumes:
  pgdata:
```

- [ ] **Step 2: Validate the compose file (requires docker CLI)**

Run: `docker compose --env-file .env.example config -q`
Expected: no output, exit 0 (YAML + interpolation valid; `--env-file .env.example` supplies the `${…}` values for validation).

(If no Docker CLI is available, record the deferral; the file is still committed for review. A reviewer can eyeball service names, `depends_on` conditions, and the two healthcheck commands.)

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "feat(packaging): docker-compose stack (postgres, redis, migrate, control-plane, data-plane, worker)"
```

---

### Task 6: `scripts/smoke.sh` — one-command stack smoke (requires Docker daemon)

An executable script that proves the packaging works end to end: bring the stack up, confirm `migrate` completed, confirm all three health endpoints answer, then tear down.

**Files:**
- Create: `scripts/smoke.sh`

- [ ] **Step 1: Write the smoke script**

Create `scripts/smoke.sh` (make it executable — `chmod +x`):
```bash
#!/usr/bin/env bash
# Bring the whole stack up from a clean state, verify migrate + health, then tear down.
# Requires a Docker daemon. Usage: ./scripts/smoke.sh
set -euo pipefail

ENV_FILE="${ENV_FILE:-.env.example}"
COMPOSE="docker compose --env-file ${ENV_FILE}"

cleanup() { $COMPOSE down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== building + starting stack =="
$COMPOSE up -d --build

echo "== waiting for migrate to complete =="
# migrate is a one-shot; it should exit 0. Wait for it to finish, then check its exit code.
$COMPOSE wait migrate
code=$($COMPOSE ps -a --format '{{.ExitCode}}' migrate)
if [ "$code" != "0" ]; then echo "migrate exited $code"; $COMPOSE logs migrate; exit 1; fi
echo "migrate OK"

echo "== waiting for health endpoints =="
for probe in \
  "data-plane http://localhost:8787/healthz" \
  "data-plane http://localhost:8787/readyz" \
  "control-plane http://localhost:3000/api/healthz"; do
  name=$(echo "$probe" | awk '{print $1}')
  url=$(echo "$probe" | awk '{print $2}')
  ok=""
  for _ in $(seq 1 30); do
    if curl -fsS "$url" >/dev/null 2>&1; then ok=1; break; fi
    sleep 2
  done
  if [ -z "$ok" ]; then echo "FAILED: $name $url"; $COMPOSE logs "$name"; exit 1; fi
  echo "OK: $name $url"
done

echo "== smoke passed =="
```

- [ ] **Step 2: Run the smoke (requires Docker daemon)**

Run: `./scripts/smoke.sh`
Expected: prints `migrate OK`, three `OK:` lines, then `== smoke passed ==`, exit 0. (`curl` here runs on the HOST, not in a container, so host `curl` is fine.)

(If no Docker daemon is available in this environment, record that the smoke was deferred to a local/Docker-capable run; the script is still committed for review.)

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke.sh
git commit -m "feat(packaging): scripts/smoke.sh — compose up, verify migrate + health, tear down"
```

---

### Task 7: Deploy & operator documentation

Document the quickstart, the env matrix, the first-run seed, the operator-editable licensing placeholders, and the two deploy gotchas carried forward (trusted-proxy `X-Forwarded-For`; typecheck-needs-build).

**Files:**
- Create: `docs/DEPLOY.md`
- Create (or Modify if it exists): `README.md`

- [ ] **Step 1: Write `docs/DEPLOY.md`**

Create `docs/DEPLOY.md`:
````markdown
# Deploying MetaModels

MetaModels runs as one `docker compose` stack: Postgres, Redis, a one-shot migration step, and three app services (control-plane UI, data-plane proxy, metering worker).

## Quickstart

```bash
cp .env.example .env          # then edit .env — set the two secrets and the operator login
docker compose up -d --build  # postgres+redis -> migrate -> control-plane/data-plane/worker
docker compose run --rm control-plane pnpm seed   # create the first admin (uses OPERATOR_EMAIL/PASSWORD)
```

- Control-plane UI: http://localhost:3000
- Data-plane proxy: http://localhost:8787 (`/healthz`, `/readyz`)

Migrations run automatically via the `migrate` service before the apps start; it exits 0 when the database is up to date.

## Environment

| Var | Service(s) | Notes |
|-----|-----------|-------|
| `DATABASE_URL` | all | Postgres connection string. |
| `REDIS_URL` | data-plane (opt), worker (required) | Without it the data-plane runs single-process/in-memory (no durable metering); the worker requires it. |
| `PORT` | data-plane | Default `8787`. |
| `SESSION_SECRET` | control-plane | ≥16 chars. `openssl rand -hex 32`. |
| `LICENSE_KEY_SECRET` | control-plane | ≥16 chars, high-entropy. Encrypts the stored Lemon Squeezy license key at rest — losing/rotating it makes an existing entitlement undecryptable (re-activate the license). |
| `OPERATOR_EMAIL` / `OPERATOR_PASSWORD` | control-plane seed | The first admin created by `pnpm seed`. |
| `WORKER_NAME` | worker | Optional consumer name; defaults to `worker-<pid>`. |

## Connecting a local Ollama / ComfyUI

The data-plane container reaches host services via `host.docker.internal` (wired with `extra_hosts` in compose). In the control-plane UI, set a Flock's upstream URL to e.g. `http://host.docker.internal:11434` (Ollama) or `http://host.docker.internal:8188` (ComfyUI).

## Licensing (operator-editable placeholders)

Lemon Squeezy licensing (the paid seat unlock) ships with placeholders to edit for your store:
- `TIER_SEATS` in `apps/control-plane/src/server/entitlement-service.ts` — maps your LS **variant name** → seat count (e.g. `{ 'Team 5': 5, 'Team 10': 10 }`). Unknown variants fall back to the free base (1 seat).
- The storefront link in `apps/control-plane/src/app/(app)/settings/settings-client.tsx` — the `https://lemonsqueezy.com` placeholder → your store URL.

Re-validation is best-effort on login + on-demand from *Settings → Upgrade*; a 7-day offline-grace window covers transient license-server outages. (A background re-validation scheduler is Plan 6c.)

## Deploy gotchas

- **Trusted reverse proxy for the login throttle.** The control-plane login throttle keys on the first `X-Forwarded-For` hop, which is client-spoofable unless a trusted proxy overwrites it. Terminate at a proxy that sets `X-Forwarded-For` to the real client IP. The throttle is also in-memory per-process — a multi-node deploy needs a shared store (reuse the data-plane Redis limiter concept).
- **Typecheck needs a build first.** Control-plane `tsc -b` depends on `.next/types` produced by `next build`/`next typegen`; a cold clone must build the app before typechecking it. (Enforced in Plan 6b CI.)
- **Pin base images by digest in production.** The Dockerfile/compose use `node:24-bookworm-slim`, `postgres:16-bookworm`, `redis:7-bookworm` tags for readability; pin each by `@sha256:` for reproducible, tamper-evident builds.
````

- [ ] **Step 2: Write/append the root `README.md` quickstart**

If `README.md` does not exist, create it; if it exists, add this section near the top (do not duplicate an existing quickstart):
```markdown
## Run the stack

```bash
cp .env.example .env   # edit secrets + operator login
docker compose up -d --build
docker compose run --rm control-plane pnpm seed
```

Control-plane UI at http://localhost:3000, data-plane proxy at http://localhost:8787. Full instructions: [docs/DEPLOY.md](docs/DEPLOY.md).
```

- [ ] **Step 3: Commit**

```bash
git add docs/DEPLOY.md README.md
git commit -m "docs(packaging): DEPLOY.md + README quickstart (env, seed, operator config, deploy gotchas)"
```

---

### Task 8: Verification gate

**Files:** none (verification only).

- [ ] **Step 1: Typecheck**

Run: `pnpm -w exec tsc -b` → clean.

- [ ] **Step 2: Both test lanes**

Run: `pnpm test` → root **192 pass / 3 skip** (baseline 189 + Task 1's 1 + Task 3's 2 = 192; confirm the exact number and that nothing regressed).
Run: `pnpm --filter @metamodels/control-plane exec vitest run --testTimeout=30000` → **167 pass** (baseline 166 + Task 2's 1). Record the count.

- [ ] **Step 3: Docker artifacts (requires Docker daemon — record results or the deferral)**

Run: `docker compose --env-file .env.example config -q` → exit 0.
Run: `./scripts/smoke.sh` → `== smoke passed ==`.
If no Docker daemon is available, state clearly that these were deferred to a Docker-capable run and were NOT executed here — do not claim a pass that did not happen.

- [ ] **Step 4: No commit**

Verification only; no file changes expected.

---

## Self-Review

**Spec coverage (roadmap Plan 6 row + carry-forward items that belong to 6a):**
- `docker compose up` runs all services, multi-stage images, env config → Tasks 4/5/1. ✓
- README + setup docs → Task 7 (`DEPLOY.md` + README). ✓
- Production migration path (the apps do NOT migrate at boot) → Task 3 `apps/migrate` + compose `migrate` service. ✓
- Control-plane healthcheck (it had no health route) → Task 2. ✓
- Operator-config docs (`TIER_SEATS`, storefront URL, `LICENSE_KEY_SECRET` high-entropy) — Plan 5.7b carry-forward → Task 7. ✓
- Deploy gotchas carried forward (trusted-proxy `X-Forwarded-For`; typecheck-needs-build; migration `0003` fence-uniqueness note is informational) → Task 7. ✓
- **Deferred to 6b (out of scope here, stated):** GitHub Actions/CI, zizmor/SHA-pin/frozen-lockfile/CODEOWNERS, the skipIf worker consumer-group test on real Redis, the per-org-lock Postgres concurrency test, the config pub/sub boot smoke. **Deferred to 6c:** the LS revalidation scheduler (`apps/scheduler`). **End-to-end acceptance flow** (connect Ollama/ComfyUI, publish paddocks, mint key, consumer call with metering) is the documented manual runbook here; its automated form (fake upstreams) lands with 6b CI.

**Placeholder scan:** every code/config step carries complete content — the env test, the healthz route + test, the migrate runner + test, the full Dockerfile, the full compose file, the full smoke script, the full docs. The one "copy an existing file verbatim" instruction (Task 3 `apps/migrate/tsconfig.json` ← `apps/worker/tsconfig.json`) names the exact source to reproduce. No TBD/TODO.

**Type/name consistency:** `loadDatabaseUrl`/`runMigrations` (Task 3) are used by the direct-exec guard in the same file; `GET` (Task 2) is imported by its test; compose service names (`postgres`/`redis`/`migrate`/`control-plane`/`data-plane`/`worker`) match the `depends_on` references and the smoke script; the Dockerfile build targets (`control-plane`, `tsx-app`) and `ARG APP` values (`data-plane`/`worker`/`migrate`) match the compose `build.target`/`args.APP`; the healthcheck URLs (`/api/healthz` :3000, `/healthz` :8787) match Task 2 and the existing data-plane route; `.env.example` keys match the Global-Constraints env matrix and the drift test's exclusion set. ✓

**Decisions flagged for the reviewer:** (1) tsx-at-runtime + full (non-`--prod`) install so `tsx` is present — image size deliberately traded for simplicity; (2) programmatic migrator in a one-shot service, `drizzle-kit` kept out of runtime images; (3) control-plane `/api/healthz` is liveness-only (no DB) so a slow Postgres can't flap it; (4) Docker-dependent steps (Tasks 4–6, Task 8 Step 3) require a daemon and must be honestly reported as run-or-deferred, never assumed-green; (5) base images tag-pinned with a digest-pin recommendation (enforcement deferred to 6b).
