# @metamodels/data-plane

The MetaModels data plane: a self-hosted governance/monetization proxy that sits
in front of local AI backends (Ollama today; ComfyUI next). Every request runs the
hot path **authenticate → rate-limit → guard → proxy → meter** before it reaches an
upstream flock.

## Request contract

All traffic goes through a single catch-all route:

```
ALL /p/:slug/*
```

- `:slug` selects the **paddock** (a scoped configuration bound to a breed and a
  flock of upstreams). Everything after the slug is forwarded upstream verbatim,
  e.g. `POST /p/small/api/chat` proxies to `/api/chat` on the paddock's flock.
- The route classifies the upstream path per breed, denies mutating routes,
  enforces the model allowlist, applies the rate limit, proxies (streaming NDJSON
  is passed through via tee), and records token/usage metering keyed by `org_id`.

## Authentication

Send your API key on every request, either as a bearer token or an `x-api-key`
header:

```
Authorization: Bearer mm_live_...
# or
x-api-key: mm_live_...
```

Keys are `mm_live_`-prefixed. The plane hashes the plaintext and resolves the key
to its org, paddock scopes, and any per-key overrides; a key must be scoped to the
paddock slug it is calling.

## Running it

```bash
# 1. Apply migrations against your Postgres database
pnpm --filter @metamodels/schema db:migrate

# 2. Start the server (reads DATABASE_URL and PORT from the environment)
pnpm --filter @metamodels/data-plane dev
```

Configuration comes from the environment (see `.env.example`):

- `DATABASE_URL` (**required**) — Postgres connection string. The server throws on
  startup if it is missing.
- `PORT` (optional) — listen port, defaults to `8787`.

`dev` runs with `tsx watch` for reload; `start` runs once with `tsx`.

> **Note:** the runtime currently wires the in-memory rate limiter and meter sink.
> Plan 4 swaps in the Redis-backed implementations at those two constructor
> arguments in `src/server.ts`; nothing else in the bootstrap changes.
