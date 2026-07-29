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
