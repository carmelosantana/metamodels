# @metamodels/e2e — the v1 acceptance walkthrough

One Playwright suite that drives the operator console the way a person would, then proves
the resulting policy is real by calling the data plane over HTTP as a consumer.

It is the answer to "does MetaModels actually do what it claims?", and the screenshots in
[`docs/screenshots/`](../../docs/screenshots) are its by-product.

## What it asserts

| Step | Claim under test |
|------|------------------|
| 1–3 | An operator can sign in, connect a flock to a real upstream, and publish a paddock |
| 4 | A fence can restrict route classes, models, and request rate |
| 5 | A key is minted once and never shown again |
| 6 | **The fence is enforced** — see below |
| 7 | Real usage is metered and surfaced to the operator |
| 8 | Every configuration change is attributable in the audit log |

Step 6 is the heart of it. Five requests against the running proxy:

- allowed model on an allowed route → **200**, with a real completion from a real model
- a model outside the allowlist → **403**
- `POST /api/pull` → **403** — model management is never exposable, even to a valid key
- no key at all → **401**
- bursting past the rate limit → **429**

The suite also fails if the console logs a **CSP violation or page error** on any screen it
visits. A blocked script degrades the UI without failing any ordinary assertion, and this
walkthrough happens to visit every screen.

## Running it

The suite drives a stack that is already running — it does not start one.

```bash
docker compose up -d
docker compose run --rm control-plane pnpm seed   # first run only
pnpm --filter @metamodels/e2e exec playwright install chromium   # first run only
```

Then, from `apps/e2e`:

```bash
OLLAMA_TEST_URL=http://ollama:11434 pnpm test:e2e
```

Without `OLLAMA_TEST_URL` the suite **skips** rather than fails — the same opt-in
convention as the `PG_TEST_URL` / `REDIS_TEST_URL` integration suites.

| Variable | Default | Notes |
|----------|---------|-------|
| `OLLAMA_TEST_URL` | *(unset — suite skips)* | Must be reachable **from inside the data-plane container**, so a LAN address or a resolvable host — not `localhost`, which inside the container is the container itself |
| `OLLAMA_TEST_MODEL` | `qwen2.5-coder:0.5b` | Must exist upstream. A small model keeps the run fast |
| `E2E_BASE_URL` | `http://localhost:3000` | Control-plane. Match `CONTROL_PLANE_PORT` if you changed it |
| `E2E_PROXY_URL` | `http://localhost:8787` | Data-plane |
| `OPERATOR_EMAIL` / `OPERATOR_PASSWORD` | `admin@example.com` / `change-me` | The seeded operator |

## Notes for whoever changes this next

- **Specs are `specs/*.spec.ts`, deliberately not `test/*.test.ts`.** The root vitest lane
  globs `apps/**/test/**/*.test.ts`; a spec placed under a `test/` directory gets collected
  by vitest too, and fails there. Keep them out of that path.
- **Fixtures are namespaced per run** (`e2e-ollama-<id>`, `e2e-paddock-<id>`) and removed on
  teardown, because this runs against a console with real operator data in it. A sweep at
  start-up also clears fixtures a previously *failed* run left behind. Both match the exact
  naming shape, never a bare `e2e` prefix, so they cannot delete something you named.
- **Assert on the metric cells, not the row.** The run id contains digits, so a regex for
  "some number" against a whole table row passes even on zero usage. That mistake was made
  and caught here once already.
- **`hasText` matches concatenated `textContent`.** The visible gaps between a row's spans
  are layout, not characters — `'create paddock:'` never matches; `'paddock:'` does.
- **Screenshots are committed documentation.** Fixed 1280×800 viewport, and anything
  secret-shaped is masked via `shot(page, name, { mask: [...] })`. Never commit a shot with
  a readable key in it.
- **Not wired into CI.** It needs a real upstream on the LAN, so in CI it would only ever
  skip. Run it locally before a release.
