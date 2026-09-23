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

### Sign-in (`specs/sign-in.spec.ts`)

Signing in is handed to the auth service (`apps/auth`, an OpenID Provider). This spec proves
the round trip in a real browser: `/login` lands on the auth service's password form, a
correct password comes back to a signed-in console with an `HttpOnly`, `SameSite=Lax`
session cookie, a wrong one stays on the form and mints nothing, and **Sign out** ends the
auth service's session as well as the console's. No CSP violation is tolerated on either
origin. It needs no upstream model, so it never skips.

Each run records **one failed login** against the auth service (the wrong-password check).
The auth service's throttle refuses every login from an address after five failures within
15 minutes, even a correct one, so a sixth run inside that window fails at sign-in. Wait for
the window to pass, or restart the auth container (the throttle is in memory).

### Admin API (`specs/admin-api.spec.ts`)

The admin API ([`docs/admin-api.md`](../../docs/admin-api.md)) driven through the real `mm` CLI.
The spec runs `apps/cli` as a child process, reads the verification link it prints, and approves
the sign-in in Chromium the way a person would: Continue, check the code and the requesting
machine's IP and user agent, Approve, then type the password. It asserts `mm login` exits 0 and
leaves a `0600` credential file in a `0700` directory. Every sign-in uses a fresh temporary
`XDG_CONFIG_HOME`, so your own `~/.config/metamodels` is never read or written. No CSP violation
or page error is tolerated on the device pages.

| Step | Claim under test |
|------|------------------|
| 1 | A device login ends in a stored, resource-bound token with the scopes asked for |
| 2 | The CLI creates, reads, replaces and deletes a flock and a paddock, creates a key and revokes it. There is no `mm keys delete` |
| 3 | A `read`-only token is refused `POST /flocks` with `403` and `capability: resource.write` |
| 4 | A `viewer` whose token carries `resource.write` is still refused: scopes never exceed the role |
| 5 | No token → `401` with `WWW-Authenticate: Bearer`; bearer plus `mm_session` cookie → `400`; cookie alone → `401`; the CLI's ID token (another audience) → `401`; `DELETE /keys/{id}` → `405`; `GET /openapi.json` with no token → `200` |

It writes to the stack and changes a user's role, so **it runs only against a stack you name
explicitly**. Unless `E2E_BASE_URL`, `E2E_AUTH_URL`, `E2E_VIEWER_EMAIL` and `E2E_VIEWER_PASSWORD`
are all set, it skips. It never falls back to the `localhost` defaults. Point it at a throwaway
stack, not one with real data.

The viewer is a second user, seeded the same way as the operator. The spec demotes it to `viewer`
on the console's Team page:

```bash
OPERATOR_EMAIL=viewer@example.test OPERATOR_PASSWORD=<a password> \
  docker compose run --rm -e OPERATOR_EMAIL -e OPERATOR_PASSWORD control-plane pnpm seed
```

Each run prints the `jti` of its token and the `audit_log` targets it touched. Each of those rows
must carry `changed_by = token:metamodels-cli:<jti>`. The spec does not query the database, so check
this from the stack:

```bash
docker compose exec -T postgres psql -U metamodels -d metamodels \
  -c "select action, target, changed_by from audit_log order by created_at desc limit 10;"
```

The spec does not cover the signing-key rotation overlap. That check recreates the sign-in service
with a changed key, and a committed test should never do that: one wrong environment variable and it
rotates a real stack's key. Run it by hand, following
[Rotating the sign-in keys](../../docs/DEPLOY.md#rotating-the-sign-in-keys).

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

Without `OLLAMA_TEST_URL` the walkthrough **skips** rather than fails — the same opt-in
convention as the `PG_TEST_URL` / `REDIS_TEST_URL` integration suites. The sign-in spec
still runs.

| Variable | Default | Notes |
|----------|---------|-------|
| `OLLAMA_TEST_URL` | *(unset — suite skips)* | Must be reachable **from inside the data-plane container**, so a LAN address or a resolvable host — not `localhost`, which inside the container is the container itself |
| `OLLAMA_TEST_MODEL` | `qwen2.5-coder:0.5b` | Must exist upstream. A small model keeps the run fast |
| `E2E_BASE_URL` | `http://localhost:3000` | Control-plane. Match `CONTROL_PLANE_PORT` if you changed it |
| `E2E_PROXY_URL` | `http://localhost:8787` | Data-plane |
| `E2E_AUTH_URL` | `http://localhost:3100` | Auth service. Must equal the stack's `OIDC_ISSUER` |
| `OPERATOR_EMAIL` / `OPERATOR_PASSWORD` | `admin@example.com` / `change-me` | The seeded operator |
| `E2E_VIEWER_EMAIL` / `E2E_VIEWER_PASSWORD` | *(unset — admin-api spec skips)* | A second seeded user, demoted to `viewer` by `admin-api.spec.ts` |

`admin-api.spec.ts` ignores the `E2E_BASE_URL` and `E2E_AUTH_URL` defaults above: both must be set
explicitly or it skips. The CLI it runs accepts plain http only to a loopback host. For a plain-http
stack elsewhere, also set `METAMODELS_ALLOW_INSECURE_HTTP=1`.

```bash
E2E_BASE_URL=http://localhost:13000 E2E_AUTH_URL=http://localhost:13100 \
E2E_VIEWER_EMAIL=viewer@example.test E2E_VIEWER_PASSWORD=<its password> \
OPERATOR_EMAIL=<seeded operator> OPERATOR_PASSWORD=<its password> \
  pnpm exec playwright test specs/admin-api.spec.ts
```

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
