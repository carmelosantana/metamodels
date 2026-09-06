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

## Deploy on Portainer (drop-in stack)

MetaModels publishes two public images to GHCR — `ghcr.io/carmelosantana/metamodels-control-plane`
and `…-runtime`. **`docker-compose.portainer.yml`** is a self-contained stack that pulls them:
no source checkout, no local build, and every non-secret value has an inline default, so a
minimal deploy only needs four secrets.

> `docker-compose.deploy.yml` is **superseded** by `docker-compose.portainer.yml`. The newer
> file is a strict superset (inline defaults, fail-fast secrets, a Redis volume, a
> loopback-by-default admin plane, optional Traefik labels). Prefer it for new stacks.

### 1. Generate the secrets

```bash
./scripts/new-stack.sh --domain api.metamodels.cc --tag 0.1.0 --email you@example.com
```

It prints a paste-ready `KEY=value` block with four 64-hex-char secrets. `--out <path>` also
writes it to a mode-600 file (it refuses to overwrite one that already exists). Secrets are
hex on purpose: `POSTGRES_PASSWORD` is interpolated into `DATABASE_URL`, and a password
containing `:/@?#` would produce a malformed connection string.

### 2. Create the stack

**Stacks → Add stack → Web editor**, paste `docker-compose.portainer.yml`, add the generated
block as the stack's **environment variables**, and Deploy. The one-shot `migrate` service
runs first; the apps start only after it exits 0.

### 3. Seed the first operator, once

```bash
docker exec -it <control-plane-container> pnpm seed
```

Uses `OPERATOR_EMAIL` / `OPERATOR_PASSWORD`. Change the password in the console afterwards.

### Variables

Four secrets are **required** and use `${VAR:?…}`, so the stack fails fast with a named
error rather than silently booting with a guessable credential:

| Required secret | Purpose |
|-----------------|---------|
| `POSTGRES_PASSWORD` | bundled Postgres, and the password inside the default `DATABASE_URL` |
| `SESSION_SECRET` | control-plane session signing (≥16 chars) |
| `LICENSE_KEY_SECRET` | encrypts the stored Lemon Squeezy key at rest. **Losing or changing it makes an existing entitlement undecryptable** — re-activate the license |
| `OPERATOR_PASSWORD` | the first admin created by `pnpm seed` |

Everything else defaults:

| Variable | Default | Notes |
|----------|---------|-------|
| `TAG` | `0.1.0` | Image tag. The git tag `v0.1.0` publishes images as `0.1.0` — the `v` is stripped |
| `API_DOMAIN` | `api.metamodels.cc` | Public host for the data-plane, used by the Traefik router rule |
| `OPERATOR_EMAIL` | `admin@metamodels.cc` | First admin's login |
| `POSTGRES_USER` / `POSTGRES_DB` | `metamodels` | Change both together, or override `DATABASE_URL` outright |
| `DATABASE_URL` | built from the Postgres vars | Set it explicitly to point at an external Postgres |
| `REDIS_URL` | `redis://redis:6379` | Required by the worker; without it the data-plane runs in-memory with no durable metering |
| `CONTROL_PLANE_BIND` | `127.0.0.1` | **Loopback on purpose** — see below |
| `CONTROL_PLANE_PORT` | `3200` | Host port for the console |
| `DATA_PLANE_BIND` / `DATA_PLANE_PORT` | `0.0.0.0` / `8787` | The public API |
| `TRAEFIK_ENABLE` | `false` | `true` to activate the router labels |
| `TRAEFIK_ENTRYPOINT` / `TRAEFIK_CERTRESOLVER` | `websecure` / `letsencrypt` | Match your Traefik's names |
| `WORKER_NAME` | `worker-1` | Consumer name |
| `SCHEDULER_INTERVAL_MS` | `43200000` (12h) | License re-validation cadence |

### The two planes are not equally public

The **data-plane is the API** — that is what `api.metamodels.cc` should point at. The
**control-plane is the admin console**, and it binds to `127.0.0.1` by default so it is not
internet-reachable. Reach it over SSH port-forwarding, a VPN, or a tunnel. Only set
`CONTROL_PLANE_BIND=0.0.0.0` if something in front of it terminates TLS and adds access
control — and note the login throttle keys on `X-Forwarded-For`, so it needs a trusted proxy
to be meaningful (see Deploy gotchas). Postgres and Redis are never port-published.

### Pointing at Ollama / ComfyUI on the same host

The `data-plane` service gets `host.docker.internal:host-gateway`, so when Ollama and ComfyUI
run in Docker on the same machine, set a Flock's upstream URL to:

```
http://host.docker.internal:11434   # Ollama
http://host.docker.internal:8188    # ComfyUI
```

That works as long as those containers publish their ports on the host. The alternative is to
attach `data-plane` to their existing Docker network and use the container name — cleaner
isolation, but it couples the stacks and Compose cannot make the network conditional, so the
host gateway is the default.

A flock URL must resolve **from inside the data-plane container**. `localhost` there is the
container itself, which is the single most common mistake.

### Ingress and TLS are not included

This stack publishes host ports; it does not terminate TLS. Point `api.metamodels.cc` at the
host by whichever route fits: a Traefik/Caddy already on that box (set `TRAEFIK_ENABLE=true`
and match the entrypoint names), or a Cloudflare Tunnel if the host is behind NAT or on a
residential connection — a tunnel needs no inbound ports and no certificate management.

Images are single-arch `linux/amd64` and carry build-provenance attestations. **Verify them
before deploying** and pin the resolved digest (see `docs/RELEASING.md` for the exact
`gh attestation verify` commands).
