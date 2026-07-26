# @metamodels/data-plane

The MetaModels data plane: a self-hosted governance/monetization proxy that sits
in front of local AI backends (Ollama and ComfyUI). Every request runs the
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

## Ollama breed

Ollama paddocks proxy through the generic hot path described above: the request is
forwarded upstream verbatim, mutating model-management routes are denied, the model
allowlist is enforced, streaming NDJSON is passed through, and token usage is
metered per `org_id`. See the request contract at the top of this document.

## ComfyUI breed

ComfyUI is **not** proxied verbatim. A consumer never submits a raw node graph and
can never reach a raw ComfyUI endpoint. Instead the operator pre-approves one or
more **workflow templates** on the paddock's fence, and the consumer submits a
`template_id` plus a flat `params` object chosen from that template. The full node
graph is reconstructed **server-side** from the template; undeclared params are
rejected.

### Submit a job

```
POST /p/:slug/submit
Content-Type: application/json

{ "template_id": "txt2img", "params": { "prompt": "a cat", "seed": 42 } }
```

→ `202 { "job_id": "..." }`

- `params` are validated against the template's declared `ParamSpec`s (`text`,
  `seed`, `number` with optional min/max, `image`). Anything not declared by the
  template is rejected; the consumer cannot inject raw graph structure.
- **Image params** are passed **base64-encoded** as string values inside the JSON
  body (there is no multipart ingress in v1). The plane decodes each one, uploads
  it to ComfyUI's `/upload/image` server-side, and rewrites the graph to reference
  the uploaded filename.
- The `job_id` is ComfyUI's `prompt_id`. The plane records job ownership (org,
  key, paddock) keyed by that id for the scoped result route below.

### Poll for the result

```
GET /p/:slug/result/:jobId
```

→ `{ "done": <bool>, "images": [...] }`

- The result is **scoped to the caller's own job**. A job that belongs to another
  key returns `404` (not `403`) so the route never leaks the existence of other
  keys' jobs; an unknown `jobId` is likewise `404`.
- The response is a curated view. The plane fetches the upstream `/history` for the
  job server-side and returns only `{ done, images }` — never the raw `/history`
  payload and never a direct `/view` URL.

### Security model

- The template + server-side graph reconstruction makes a raw-graph submission
  structurally impossible: the only ingress is `{ template_id, params }`.
- All four direct ComfyUI routes — `POST /prompt`, `POST /upload/image`,
  `GET /history`, `GET /view` — are hard-denied with **403** if a consumer tries to
  reach them directly (e.g. `POST /p/:slug/prompt`). `/history` and `/view` are
  never exposed at all; the scoped `result` view is the only output path.

### Metering

- **`jobs`** — emitted once at submit, weighted by the template's `cost`.
- **`images`** and **`gpu_ms`** — emitted once at completion, read from `/history`
  when the job first reports `done`. A second poll of an already-metered job is a
  no-op (metered exactly once per job).

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

> **Note:** the runtime currently wires the in-memory rate limiter, meter sink,
> and job store. Plan 4 swaps in the Redis-backed implementations at those
> constructor arguments in `src/server.ts`; nothing else in the bootstrap changes.
