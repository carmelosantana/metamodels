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

If either host port is already taken on your machine, set `CONTROL_PLANE_PORT` / `DATA_PLANE_PORT` in `.env` — only the host side of the mapping moves, so healthchecks and inter-container URLs are unaffected.

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
| `CONTROL_PLANE_PORT` | compose | Host port for the UI. Default `3000`. |
| `DATA_PLANE_PORT` | compose | Host port for the proxy. Default `8787`. |

## Security headers

Both planes ship hardened response headers by default; there is nothing to switch on.

- **Control-plane** sends a nonce-based `Content-Security-Policy` (`src/middleware.ts` mints a fresh nonce per request; `src/lib/csp.ts` defines the policy). It has no `'unsafe-inline'` for scripts, and `object-src`/`frame-src`/`frame-ancestors` are `'none'`. Because the nonce must be stamped into each response, every page renders per-request (`export const dynamic = 'force-dynamic'` in the root layout) — expected for a session-scoped console.
- **Data-plane** sends `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and HSTS on every response including errors and 404s. `nosniff` is the load-bearing one: the proxy relays bodies from upstream servers you control but MetaModels does not.
- **HSTS** is `max-age=63072000` with no `includeSubDomains` and no `preload`. That is deliberate for a self-hosted product: the console may share an apex domain with services you serve over plain HTTP, and `preload` is effectively irreversible. If you terminate TLS for an entire domain you own, add both in `apps/control-plane/next.config.ts` and `apps/data-plane/src/app.ts`. HSTS is ignored by browsers over plain HTTP, so a LAN deployment is unaffected either way.

**Adding a third-party script** (analytics, a widget) requires adding its origin to `script-src` in `src/lib/csp.ts` — under CSP it will otherwise be blocked, correctly. `src/lib/csp.test.ts` covers the policy.

## Connecting a local Ollama / ComfyUI

The data-plane container reaches host services via `host.docker.internal` (wired with `extra_hosts` in compose). In the control-plane UI, set a Flock's upstream URL to e.g. `http://host.docker.internal:11434` (Ollama) or `http://host.docker.internal:8188` (ComfyUI).

## Licensing (operator-editable placeholders)

Lemon Squeezy licensing (the paid seat unlock) ships with placeholders to edit for your store:
- `TIER_SEATS` in `apps/control-plane/src/server/entitlement-service.ts` — maps your LS **variant name** → seat count (e.g. `{ 'Team 5': 5, 'Team 10': 10 }`). Unknown variants fall back to the free base (1 seat).
- The storefront link in `apps/control-plane/src/app/(app)/settings/settings-client.tsx` — the `https://lemonsqueezy.com` placeholder → your store URL.

Re-validation is best-effort on login + on-demand from *Settings → Upgrade*; a 7-day offline-grace window covers transient license-server outages.

### License re-validation scheduler

The `scheduler` service re-validates every org's Lemon Squeezy entitlement on a timer, so a license can lapse (or a remote change take effect) without waiting for an operator to log in — the 7-day offline grace covers the gap between passes. Cadence is `SCHEDULER_INTERVAL_MS` (default 12h = `43200000`). It needs `DATABASE_URL` + `LICENSE_KEY_SECRET`, runs a pass on startup then every interval, and isolates each org (one failure never aborts the pass). Run exactly one scheduler instance (it has no leader election).

## Running the integration tests

Most tests run with zero setup (pglite + ioredis-mock, Docker-free). Three suites need **real** servers and are **skipped unless** their env var is set — they never run against your production data:

| Suite | Env var | What it proves |
|-------|---------|----------------|
| `apps/worker/test/worker.test.ts` | `REDIS_TEST_URL` | worker consumer-group read→apply→ack wiring |
| `apps/data-plane/test/config-pubsub.integration.test.ts` | `REDIS_TEST_URL` | config-invalidation pub/sub flushes the data-plane cache across connections |
| `apps/control-plane/src/server/org-lock-concurrency.test.ts` | `PG_TEST_URL` | the per-org `FOR UPDATE` lock serializes concurrent seat/last-admin mutations |

Run them locally against throwaway containers:
```bash
docker run -d --name mm-pg -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test -p 55432:5432 postgres:16-bookworm
docker run -d --name mm-redis -p 56379:6379 redis:7-bookworm
export PG_TEST_URL='postgres://test:test@localhost:55432/test'
export REDIS_TEST_URL='redis://localhost:56379'
pnpm test                                                   # root lane (worker + pub/sub run)
pnpm --filter @metamodels/control-plane exec vitest run --testTimeout=30000     # control-plane lane (concurrency runs)
docker rm -f mm-pg mm-redis
```

## Continuous integration

`.github/workflows/ci.yml` runs on every push/PR: frozen-lockfile install → apply migrations to the CI Postgres → control-plane build (needed before `tsc -b`, which reads `.next/types`) → typecheck → both test lanes with `postgres:16`+`redis:7` **service containers** (so all three integration suites above execute in CI) → a `build-smoke` job that runs `scripts/smoke.sh` on the full Docker stack. `.github/workflows/zizmor.yml` statically analyzes the workflows (fails on unpinned actions / misconfig). All third-party actions are pinned to full commit SHAs.

**Operator setup:** enable branch protection on `main` requiring the `test`, `build-smoke`, and `zizmor` checks and "review from Code Owners" (so `.github/CODEOWNERS` is enforced).

## Deploy gotchas

- **Trusted reverse proxy for the login throttle.** The control-plane login throttle keys on the first `X-Forwarded-For` hop, which is client-spoofable unless a trusted proxy overwrites it. Terminate at a proxy that sets `X-Forwarded-For` to the real client IP. The throttle is also in-memory per-process — a multi-node deploy needs a shared store (reuse the data-plane Redis limiter concept).
- **Typecheck needs a build first.** Control-plane `tsc -b` depends on `.next/types` produced by `next build`/`next typegen`; a cold clone must build the app before typechecking it. (Enforced in Plan 6b CI.)
- **Base images are digest-pinned; refresh them deliberately.** The Node base (`docker/Dockerfile`) and the `postgres:16-bookworm` / `redis:7-bookworm` services (compose files) are pinned by `@sha256:` for reproducible, tamper-evident builds. Pinned digests don't receive upstream security patches automatically — re-bump each on a CVE or on a quarterly cadence via `docker buildx imagetools inspect <image:tag> --format '{{.Manifest.Digest}}'`.

## Deploy on Portainer (pre-built images)

MetaModels publishes two public images to GHCR:
`ghcr.io/carmelosantana/metamodels-control-plane` and `…-runtime`. A Portainer stack pulls
them — no source checkout, no local build.

1. **Stacks → Add stack → Web editor**, paste `docker-compose.deploy.yml` from the repo.
2. Set the stack **environment variables**: `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`,
   `LICENSE_KEY_SECRET`, `OPERATOR_EMAIL`, `OPERATOR_PASSWORD`, and `TAG` (pin `0.1.0` — the
   image tag drops the `v` from the git tag `v0.1.0`; `latest` tracks the newest release, `edge`
   the latest `main`). Portainer injects these for
   both compose interpolation and the containers.
3. **Deploy the stack.** The one-shot `migrate` service runs first; the apps start after.
4. **Seed the first operator once** — in Portainer, open the `control-plane` container console
   (or `docker exec`) and run `pnpm seed`. Uses `OPERATOR_EMAIL` / `OPERATOR_PASSWORD`.
5. Open the UI on `CONTROL_PLANE_PORT` (default 3000). Point Flock upstream URLs at your
   Ollama/ComfyUI via `http://host.docker.internal:11434` etc.

Images are single-arch `linux/amd64` and carry build-provenance attestations. **Verify them
before deploying** and pin the resolved digest (see `docs/RELEASING.md` for the exact
`gh attestation verify` commands).

**Bundled Postgres credentials.** The `postgres` service in `docker-compose.deploy.yml` uses
default creds `metamodels` / `metamodels` (database `metamodels`). It is **not** port-published —
only reachable over the compose network — so this is fine for a self-contained stack. If you
expose the DB port or share the Docker network with other workloads, override `POSTGRES_USER`
and `POSTGRES_PASSWORD` and update the matching `DATABASE_URL` to keep them in sync.
