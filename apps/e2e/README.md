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
| 5 | No token → `401` with `WWW-Authenticate: Bearer`; bearer plus `mm_session` cookie → `400`; cookie alone → `401`; an ID token replayed as an access token (wrong `typ`) → `401`; `DELETE /keys/{id}` → `405`; `GET /openapi.json` with no token → `200` |

Step 5's ID token is refused on its `typ` before its `aud` is looked at, so it does not prove the
audience check. [`scripts/aud-isolation.sh`](#the-audience-check-scriptsaud-isolationsh) does.

It writes to the stack and changes a user's role, so **it runs only against a stack you name
explicitly**. Unless `E2E_BASE_URL`, `E2E_AUTH_URL`, `E2E_VIEWER_EMAIL` and `E2E_VIEWER_PASSWORD`
are all set, it skips. It never falls back to the `localhost` defaults. Point it at a throwaway
stack, not one with real data.

The walkthrough specs read `E2E_BASE_URL` and `E2E_AUTH_URL` too, so a shell that has them set for
the walkthrough is already halfway there. **The viewer variables are what really opts this spec
in**: set them only when the URLs name a throwaway stack. When `CI` is `true` or `1` (any case) and
any of the four is missing, the spec throws instead of skipping, so a CI job cannot skip it without
anyone noticing. `CI=0` or `CI=false` skips, as an unset `CI` does.

The viewer is a second user, seeded the same way as the operator. The spec demotes it to `viewer`
on the console's Team page:

```bash
OPERATOR_EMAIL=viewer@example.test OPERATOR_PASSWORD=<a password> \
  docker compose run --rm -e OPERATOR_EMAIL -e OPERATOR_PASSWORD control-plane pnpm seed
```

On teardown the spec deletes every flock this run named: `e2e-admin-flock-<run id>` itself, and
that name followed by `-` (the `-renamed` flock, and any `-denied` or `-viewer` flock a refused
write created after all). Deleting a flock deletes its paddocks. It leaves two things by design:
the key it revoked, because the admin API cannot delete a key, only revoke it; and the second user,
left as a `viewer`, which the next run reuses (the demotion is skipped when it is one already).

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

#### The audience check (`scripts/aud-isolation.sh`)

The spec cannot prove that the admin API refuses an access token issued for another audience: the
sign-in service knows one admin-API resource, so every access token it issues has the same `aud`.
`scripts/aud-isolation.sh` proves it the other way round. It starts a **second control plane** from
the throwaway stack with `CONSOLE_URL=http://other.invalid`, so that one expects the `aud`
`http://other.invalid/api/admin`. Everything else is the same: the image, `OIDC_ISSUER`,
`OIDC_INTERNAL_URL` and the key set. One real access token must then get `200` from the stack's own
control plane (the anchor: the token is otherwise valid) and `401` from the second one.

It takes the compose file, the throwaway stack's env file, a free host port and the console URL, which
must be an origin: `http(s)://host[:port]`, optionally with a trailing `/`, where the host is a
hostname, an IPv4 literal or a bracketed IPv6 literal. No userinfo, path, query or fragment. It
takes no wrapper and no compose flags, and it runs only in the throwaway compose project
`mm-m2-e2e`:

- It makes one `docker compose` call, and that call is written once in the script as `docker compose
  -p mm-m2-e2e --file=<compose file> --env-file=<env file> run …`. The project is a literal. The two
  paths are resolved to absolute paths, so neither can be read as a flag, and each is one argument.
  Nothing you pass adds or changes a project flag.
- Compose ranks `-p` above `COMPOSE_PROJECT_NAME` and above a compose file's top-level `name:`
  ([project name precedence](https://docs.docker.com/compose/how-tos/project-name/)). A
  `COMPOSE_PROJECT_NAME` in your shell or in the env file (compose reads pre-defined `COMPOSE_*`
  variables from it) therefore cannot move the project. The script unsets `COMPOSE_PROJECT_NAME`
  anyway.
- It refuses a compose file that is not this repository's `docker-compose.yml` (compared by
  `realpath`, so a symlink to it is accepted). `-p` would override another file's `name:`, but
  another file could define a different `control-plane` service, on another network.
- After `run` starts `mm-m2-e2e-aud`, and before the health check and before the token is sent
  anywhere, it reads the container's `com.docker.compose.project` label and exits `2` unless it is
  exactly `mm-m2-e2e`.
- It takes a host port of 1024-65535 written in plain decimal (no leading zero, which bash would read
  as octal), refuses one something already answers on, and publishes the second control plane on
  `127.0.0.1` only. `--no-deps` leaves the running stack alone.
- Its only destructive call is `docker rm -f mm-m2-e2e-aud`, in an `EXIT` trap, so it also runs when
  the script fails or is interrupted after `run` has succeeded. If `run` itself fails, for example
  because a container named `mm-m2-e2e-aud` already exists, the script removes nothing: that container
  is not this run's. The same goes for an interrupt before `run` returns, which can leave a container
  behind; check what it is before removing it by hand. The name `mm-m2-e2e-aud` is reserved for this
  script.
- It reads the token from `AUD_ACCESS_TOKEN` into an unexported variable and unsets
  `AUD_ACCESS_TOKEN` before starting any process, so the token is in no argument list and no child
  environment. It reaches `curl` on stdin. The script's own process keeps the environment it was
  started with, so `ps e` on that one PID still shows it. The script prints status codes only, never
  the token. Do not run it under `bash -x`.
- Every `curl` call starts `curl -q -g`. `-q` has to be the first argument to stop curl reading a
  `~/.curlrc`, where `verbose` would print the `Authorization` header. `-g` turns off URL globbing,
  so a URL cannot expand into several and send the token to each.

What the label check does not cover: which Docker daemon `docker` talks to, and what the env file
points the container at. Use the throwaway stack's own env file.

`scripts/aud-isolation.test.sh` checks all of this without Docker, with fake `docker` and `curl`
executables on `PATH`: `pnpm --filter @metamodels/e2e run test:aud-script`.

The stack must already be up, with a `control-plane` image built from the commit under test. The
token must be an unexpired access token for that stack's console. A fresh `mm login` gives one:

```bash
MM_HOME=$(mktemp -d)
XDG_CONFIG_HOME=$MM_HOME pnpm --filter @metamodels/cli start -- login \
  --issuer "$E2E_AUTH_URL" --console "$E2E_BASE_URL" --scope read
AUD_ACCESS_TOKEN=$(node -e 'process.stdout.write(require(process.argv[1])[process.argv[2]].accessToken)' \
  "$MM_HOME/metamodels/credentials.json" "$E2E_AUTH_URL") \
  apps/e2e/scripts/aud-isolation.sh docker-compose.yml <the throwaway env file> <a free host port> "$E2E_BASE_URL"
rm -rf "$MM_HOME"
```

A pass prints:

```
aud-isolation: starting mm-m2-e2e-aud: CONSOLE_URL=http://other.invalid, on 127.0.0.1:<port>
aud-isolation: mm-m2-e2e-aud is in compose project mm-m2-e2e
aud-isolation: mm-m2-e2e-aud is up
original console (<console URL>): GET /api/admin/v1/flocks -> 200 (expect 200)
second console (CONSOLE_URL=http://other.invalid): GET /api/admin/v1/flocks -> 401 (expect 401)
original console again: GET /api/admin/v1/flocks -> 200 (expect 200)
aud-isolation: PASS: a token for <console URL>/api/admin is refused by a console expecting http://other.invalid/api/admin
```

and exits `0`. Anything else exits `1`. The anchor is asked twice, before and after the second
console, so a token that expires in between fails the run instead of passing it. If the anchor is not
`200` both times, the token proves nothing: get a fresh one. A `503` from the second console usually
means it could not fetch the key set.

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
