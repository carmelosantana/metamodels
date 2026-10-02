---
name: metamodels-provisioning
description: >-
  Provision and verify a governed MetaModels paddock in front of an Ollama server, through the admin
  API and the `mm` CLI: flock → paddock → fence → key, then a real request matrix through the data
  plane (allowed 200, stray model 403, /api/pull 403, no key 401). Use this WHENEVER someone wants to
  set up, re-provision, rotate or check the timeinvoice paddock, give an app (TimeInvoice, a Kanboard
  plugin, anything) a scoped LLM endpoint, put auth or metering in front of an Ollama box, or prove a
  fence is enforced — even if they only say "point TimeInvoice at Ollama through metamodels", "give
  timeinvoice a key", "rotate the timeinvoice key" or "is the proxy actually enforcing?".
---

# MetaModels provisioning

A governed endpoint is four objects behind the admin API — **flock** (the upstream) → **paddock**
(`/p/<slug>`) → **fence** (routes, models, rate) → **key** — and `scripts/provision.ts` makes all four
with `mm`, never with SQL, so each change keeps its audit entry and org scope. Default target: the
`timeinvoice` paddock. Background on the API: `docs/admin-api.md`.

| # | Step | How |
|---|------|-----|
| 1 | **Ground truth** | Stack up; the Ollama URL reachable *from the data-plane container*; the model pulled. `references/verify.md#before` |
| 2 | **Sign in** | `pnpm --filter @metamodels/cli start -- login --scope read,resource.write` (device flow; needs `METAMODELS_ISSUER`, `METAMODELS_CONSOLE_URL`) |
| 3 | **Provision + verify** | Run the script (below). Idempotent: flock by name, paddock by slug, fence replaced whole, key minted once |
| 4 | **Hand off** | The printed contract + the key (shown once, on stderr). Never into git |
| 5 | **Rotate** | Same command plus `--rotate-key`: revokes the active key of that name, mints a new one, verifies with it |

```bash
node .claude/skills/metamodels-provisioning/scripts/provision.ts \
  --ollama-url "$OLLAMA_URL" --proxy-url "$DATA_PLANE_URL" --models qwen3:8b
```

`--help` lists every option and its environment fallback. **No host is built in**: the Ollama URL and
the data-plane URL always come from the caller. `MM_CLI=mm` uses an installed `mm` instead of this
repo's `apps/cli`.

## The verify step is the point

Exit 0 means the four requests in `references/verify.md#matrix` came back exactly as the fence says.
Anything else exits 1 naming the cell. A re-run that mints no key has nothing to verify with: pass the
stored secret as `MM_PROXY_KEY`, or rotate.

## Gotchas

| Trap | Why |
|------|-----|
| `localhost` as `--ollama-url` | The data plane calls it from its container; use an address that container reaches (`host.docker.internal` on the compose stack, or the box's name) |
| `--proxy-url` vs the stack's `DATA_PLANE_URL` | `--proxy-url` is where *this machine* reaches the data plane; they can differ |
| The slug is taken | Slugs are global. One publishing another flock is refused, never re-pointed |
| `409` replacing the flock | Its base URL changed while an upstream credential is stored; the API makes you resend it (console or `mm flocks replace`) |
| First call is slow | A cold model load; the verify waits for it |
| `/api/pull` is 403 even with a key | By design: model management is never exposable |

## Tests

`scripts/provision.test.ts` runs in the root lane (`pnpm test`): a fake `mm` and a fake data plane,
plus a guard that no private IPv4 address appears anywhere in this skill.
