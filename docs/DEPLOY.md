# Deploying MetaModels

MetaModels runs as one `docker compose` stack: Postgres, Redis, a one-shot migration step, and four app services (control-plane UI, auth sign-in service, data-plane proxy, metering worker).

## Quickstart

```bash
cp .env.example .env          # then edit .env — set the secrets and the operator login
docker compose up -d --build  # postgres+redis -> migrate -> control-plane/auth/data-plane/worker
docker compose run --rm control-plane pnpm seed   # create the first admin (uses OPERATOR_EMAIL/PASSWORD)
```

- Control-plane UI: http://localhost:3000
- Data-plane proxy: http://localhost:8787 (`/healthz`, `/readyz`)
- Sign-in service: http://localhost:3100 — the console sends your browser here to sign in, so it must be reachable at exactly `OIDC_ISSUER`

If a host port is already taken on your machine, set `CONTROL_PLANE_PORT` / `DATA_PLANE_PORT` / `AUTH_HOST_PORT` in `.env` — only the host side of the mapping moves, so healthchecks and inter-container URLs are unaffected. Moving the console or sign-in port also moves its public URL: update `CONSOLE_URL` / `OIDC_ISSUER` to match.

Migrations run automatically via the `migrate` service before the apps start; it exits 0 when the database is up to date.

`.env.example` sets `OIDC_ALLOW_EPHEMERAL_KEY=true` with an empty `OIDC_SIGNING_KEY`, so a local stack signs tokens with a throwaway key that changes on every restart of the `auth` service. That is fine for local use. Any real deployment must set `OIDC_SIGNING_KEY`; the deploy and Portainer stacks hard-wire `OIDC_ALLOW_EPHEMERAL_KEY` to `false`.

## Environment

| Var | Service(s) | Notes |
|-----|-----------|-------|
| `DATABASE_URL` | all | Postgres connection string. |
| `REDIS_URL` | data-plane (opt), worker (required) | Without it the data-plane runs single-process/in-memory (no durable metering); the worker requires it. |
| `PORT` | data-plane | Default `8787`. |
| `SESSION_SECRET` | control-plane | ≥16 chars. `openssl rand -hex 32`. |
| `OIDC_ISSUER` | auth, control-plane | Public URL of the sign-in service, origin only. Also the token issuer, so browsers and clients must see exactly this. |
| `CONSOLE_URL` | auth, control-plane | Public URL of the console, origin only. Its sign-in redirect and post-logout URIs derive from it. |
| `OIDC_INTERNAL_URL` | control-plane | How the console reaches the sign-in service server-to-server: `http://auth:3100` in compose. Defaults to `OIDC_ISSUER`. |
| `CONSOLE_CLIENT_SECRET` | auth, control-plane | ≥16 chars, the same value in both. `openssl rand -hex 32`. |
| `OIDC_COOKIE_KEYS` | auth | Cookie-signing keys, comma-separated, newest first, each ≥16 chars. |
| `OIDC_SIGNING_KEY` | auth | Base64 of an RSA ≥2048-bit PKCS#8 PEM that signs every token: `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \| openssl base64 -A`. Rotate it through `OIDC_PREVIOUS_SIGNING_KEYS` so issued tokens survive — see [Rotating the sign-in keys](#rotating-the-sign-in-keys). |
| `OIDC_PREVIOUS_SIGNING_KEYS` | auth | Optional. Comma-separated retired signing keys, same format and same rules as `OIDC_SIGNING_KEY`. Published for verification only, after the signer, so they never sign a new token. This is the rotation overlap window. |
| `OIDC_ALLOW_EPHEMERAL_KEY` | auth | Local development and CI only: with no `OIDC_SIGNING_KEY`, mint a throwaway key at boot. Never in production. |
| `AUTH_PORT` | auth | Listen port inside the container. Compose pins it to `3100`; move `AUTH_HOST_PORT` instead. |
| `LICENSE_KEY_SECRET` | control-plane | ≥16 chars, high-entropy. Encrypts the stored Lemon Squeezy license key at rest — losing/rotating it makes an existing entitlement undecryptable (re-activate the license). |
| `UPSTREAM_AUTH_KEY` | migrate, control-plane, data-plane | Base64 of **exactly** 32 random bytes: `openssl rand -base64 32`. Encrypts each flock's upstream credential at rest; all three services must hold the same value, and each exits with status 1 at start-up without a valid one. Rotate it through `UPSTREAM_AUTH_PREVIOUS_KEYS` — see [Rotating the upstream credential key](#rotating-the-upstream-credential-key). The `.env.example` value is for local use and CI only. |
| `UPSTREAM_AUTH_PREVIOUS_KEYS` | migrate, control-plane, data-plane | Optional. Comma-separated retired keys, same format. They only open credentials, never seal them, and `migrate` re-seals whatever they open under `UPSTREAM_AUTH_KEY`. Usually empty. |
| `OPERATOR_EMAIL` / `OPERATOR_PASSWORD` | control-plane seed | The first admin created by `pnpm seed`. There is no password-change screen yet; see [Retiring the seeded admin](#retiring-the-seeded-admin). |
| `WORKER_NAME` | worker | Optional consumer name; defaults to `worker-<pid>`. |
| `CONTROL_PLANE_PORT` | compose | Host port for the UI. Default `3000`. |
| `DATA_PLANE_PORT` | compose | Host port for the proxy. Default `8787`. |
| `AUTH_HOST_PORT` | compose | Host port for the sign-in service. Default `3100`. |
| `METAMODELS_ISSUER` | admin CLI (operator's machine) | Not read by any service. The sign-in service `mm` signs in against: exactly the deployment's `OIDC_ISSUER`. `--issuer` overrides. No default. |
| `METAMODELS_CONSOLE_URL` | admin CLI (operator's machine) | Not read by any service. The console whose admin API `mm` calls: exactly the deployment's `CONSOLE_URL`, since the CLI's tokens are bound to the resource derived from it. `--console` overrides. No default. |
| `METAMODELS_ALLOW_INSECURE_HTTP` | admin CLI (operator's machine) | Not read by any service. `mm` refuses plain `http://` to a host that is not loopback (`localhost`, `127.0.0.0/8`, `::1`) for the issuer, the console and the endpoints the sign-in service advertises, since it sends tokens to them, and for the page `mm login` sends the operator to, since they type their password there. `1` (or `--allow-insecure-http`) allows it, with a warning on stderr on every run. Default off. |

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

- **Trusted reverse proxy for the login throttle.** The sign-in throttle (in the auth service) keys on the first `X-Forwarded-For` hop, which is client-spoofable unless a trusted proxy overwrites it. The IP address the CLI approval page shows for the requesting machine is that same hop, so it is only as trustworthy as the proxy. Terminate at a proxy that sets `X-Forwarded-For` to the real client IP. The throttle is also in-memory per-process — a multi-node deploy needs a shared store (reuse the data-plane Redis limiter concept).
- **Typecheck needs a build first.** Control-plane `tsc -b` depends on `.next/types` produced by `next build`/`next typegen`; a cold clone must build the app before typechecking it. (Enforced in Plan 6b CI.)
- **Base images are digest-pinned; refresh them deliberately.** The Node base (`docker/Dockerfile`) and the `postgres:16-bookworm` / `redis:7-bookworm` services (compose files) are pinned by `@sha256:` for reproducible, tamper-evident builds. Pinned digests don't receive upstream security patches automatically — re-bump each on a CVE or on a quarterly cadence via `docker buildx imagetools inspect <image:tag> --format '{{.Manifest.Digest}}'`.

## Deploy on Portainer (drop-in stack)

MetaModels publishes two public images to GHCR — `ghcr.io/carmelosantana/metamodels-control-plane`
and `…-runtime`. **`docker-compose.portainer.yml`** is a self-contained stack that pulls them:
no source checkout, no local build, and every non-secret value has an inline default, so a
minimal deploy only needs seven secrets.

> `docker-compose.deploy.yml` is **superseded** by `docker-compose.portainer.yml`. The newer
> file is a strict superset (inline defaults, fail-fast secrets, a Redis volume, a
> loopback-by-default admin plane, optional Traefik labels). Prefer it for new stacks.

### 1. Generate the secrets

```bash
./scripts/new-stack.sh --domain api.metamodels.cc --tag 0.4.0 --email you@example.com
```

It prints a paste-ready `KEY=value` block with six 64-hex-char secrets and an RSA signing key. `--out <path>` also
writes it to a mode-600 file (it refuses to overwrite one that already exists). Secrets are
hex on purpose: `POSTGRES_PASSWORD` is interpolated into `DATABASE_URL`, and a password
containing `:/@?#` would produce a malformed connection string.

### 2. Create the stack

**Stacks → Add stack → Web editor**, paste `docker-compose.portainer.yml`, add the generated
block as the stack's **environment variables**, and Deploy. The one-shot `migrate` service
runs first; the apps start only after it exits 0.

### 3. Nothing else — the first operator is seeded automatically

A one-shot `seed` service runs after `migrate` and creates the first admin from
`OPERATOR_EMAIL` / `OPERATOR_PASSWORD`, so a Portainer-only deploy needs **no shell access at
all**. **Change the password in the console after first login.**

It is safe on every restart: `seedAdmin` returns early when the email already exists and never
touches an existing password (`Admin <email> already exists — no change.`, exit 0). It exits
non-zero — loudly, in that service's log — if the email belongs to a **non-admin** user, which
is a real misconfiguration rather than noise. Nothing depends on `seed` completing, so a failed
seed never takes the stack down.

To seed a different account later, or to re-run it by hand, the image still carries the script:

```bash
docker exec -it <control-plane-container> pnpm seed
```

### Variables

Seven secrets are **required** and use `${VAR:?…}`, so the stack fails fast with a named
error rather than silently booting with a guessable credential:

| Required secret | Purpose |
|-----------------|---------|
| `POSTGRES_PASSWORD` | bundled Postgres, and the password inside the default `DATABASE_URL` |
| `SESSION_SECRET` | control-plane session signing (≥16 chars) |
| `LICENSE_KEY_SECRET` | encrypts the stored Lemon Squeezy key at rest. **Losing or changing it makes an existing entitlement undecryptable** — re-activate the license |
| `UPSTREAM_AUTH_KEY` | encrypts each flock's upstream credential at rest (`openssl rand -base64 32`). Rotate it via `UPSTREAM_AUTH_PREVIOUS_KEYS`; **losing it means re-entering every flock's credential** |
| `OPERATOR_PASSWORD` | the first admin created by `pnpm seed`. No password-change screen yet — see [Retiring the seeded admin](#retiring-the-seeded-admin) |
| `CONSOLE_CLIENT_SECRET` | authenticates the console to the sign-in service (≥16 chars; both services read it) |
| `OIDC_COOKIE_KEYS` | signs the sign-in service's cookies. Rotate by prepending a new key: `<new>,<old>` |
| `OIDC_SIGNING_KEY` | signs every token (base64 of an RSA PKCS#8 PEM). Rotate it via `OIDC_PREVIOUS_SIGNING_KEYS`, or issued access tokens stop verifying once the console's 10-minute copy of the keys expires; it does **not** sign anyone out |

Everything else defaults:

| Variable | Default | Notes |
|----------|---------|-------|
| `TAG` | `0.4.0` | Image tag. The git tag `v0.4.0` publishes images as `0.4.0` — the `v` is stripped |
| `API_DOMAIN` | `api.metamodels.cc` | Public host for the data-plane, used by the Traefik router rule |
| `OPERATOR_EMAIL` | `admin@metamodels.cc` | First admin's login |
| `POSTGRES_USER` / `POSTGRES_DB` | `metamodels` | Change both together, or override `DATABASE_URL` outright |
| `DATABASE_URL` | built from the Postgres vars | Set it explicitly to point at an external Postgres |
| `REDIS_URL` | `redis://redis:6379` | Required by the worker; without it the data-plane runs in-memory with no durable metering |
| `CONTROL_PLANE_BIND` | `127.0.0.1` | **Loopback on purpose** — see below |
| `CONTROL_PLANE_PORT` | `3200` | Host port for the console |
| `AUTH_BIND` / `AUTH_HOST_PORT` | `127.0.0.1` / `3100` | The sign-in service — loopback, like the console |
| `CONSOLE_URL` | `http://127.0.0.1:<CONTROL_PLANE_PORT>` | Where you open the console. Must match your browser's address bar exactly |
| `OIDC_ISSUER` | `http://127.0.0.1:<AUTH_HOST_PORT>` | Where browsers reach the sign-in service; also the token issuer |
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

The **sign-in service** (`auth`) is admin-side too and binds to `127.0.0.1` by default. The
console sends your browser to it to sign in, so forward **both** ports —
`ssh -L 3200:127.0.0.1:3200 -L 3100:127.0.0.1:3100 <host>` — then open exactly `CONSOLE_URL`.
If you put either behind TLS, set `CONSOLE_URL` and `OIDC_ISSUER` to the public `https://`
origins: both are compared exactly, and a mismatch fails sign-in with an issuer or
redirect-URI error.

### Retiring the seeded admin

`OPERATOR_PASSWORD` is only read by `pnpm seed` when it creates the first admin. The console has
no password-change screen yet, and re-running `pnpm seed` will **not** reset an existing user — it
returns the account untouched. To stop relying on that password:

1. Sign in as the seeded admin and invite a second **admin** from **Team**. The invitee sets their
   own password when they accept, then signs in through the sign-in service.
2. Sign in as the new admin and **deactivate** the seeded account from **Team**. Deactivation takes
   effect on the next request: the console re-reads the user on every request, so an existing
   session stops working immediately.

Keep at least one active admin — deactivating the last one locks everybody out of the console.

### Rotating the sign-in keys

- **`OIDC_COOKIE_KEYS`** — prepend a new key (`<new>,<old>`) and redeploy: new cookies are
  signed with it and old ones still verify. Drop the old key after a day.
- **`OIDC_SIGNING_KEY`** — rotate it with an overlap window, or every access token already issued
  stops verifying once the console's cached copy of the sign-in service's keys expires, within
  10 minutes:

  1. In a single edit, applied together before any redeploy: move the current `OIDC_SIGNING_KEY`
     value into `OIDC_PREVIOUS_SIGNING_KEYS` **and** set `OIDC_SIGNING_KEY` to the new key. The
     two variables must never hold the same key at the same time — that is a duplicate key id,
     and the sign-in service refuses to start, so save the environment only once both are set.
  2. Redeploy the sign-in service. It publishes both keys in its JWKS, the new one first, so new
     tokens are signed with the new key while in-flight tokens still verify against the old one.
  3. Wait out the window: the longest access-token lifetime, plus the console's JWKS cache.
  4. Clear `OIDC_PREVIOUS_SIGNING_KEYS` and redeploy again. Only now does the sign-in service stop
     publishing the old key. The console stops accepting it once its cached copy expires, within
     10 more minutes.

  Replacing `OIDC_SIGNING_KEY` on its own, with `OIDC_PREVIOUS_SIGNING_KEYS` left empty, is the
  *deliberate* way to invalidate issued tokens. The console refuses them once its cached copy of the
  keys expires, within 10 minutes, or at once if you restart the control-plane container after the
  sign-in service is running with the new key, as
  [Forcing everyone to sign in again](#forcing-everyone-to-sign-in-again) describes for a leaked
  key. Either way it does **not** sign anyone out: console sessions are HMAC-signed with
  `SESSION_SECRET`, and sign-in service sessions are database rows behind cookies signed with
  `OIDC_COOKIE_KEYS`; neither depends on this key.
- **`CONSOLE_CLIENT_SECRET`** — both services read the same stack variable, so change it and
  redeploy; nobody is signed out.

### Rotating the upstream credential key

A flock's upstream credential is stored encrypted under `UPSTREAM_AUTH_KEY`, and no API response
or console page returns it. Each stored value records which key encrypted it. Every deploy runs
`migrate` before any other service starts, and `migrate` re-encrypts every credential under the
current key. So a rotation completes on the deploy that introduces the new key, with no waiting
window:

1. In a single edit, applied together before any redeploy: move the current `UPSTREAM_AUTH_KEY`
   value into `UPSTREAM_AUTH_PREVIOUS_KEYS` **and** set `UPSTREAM_AUTH_KEY` to a new
   `openssl rand -base64 32`. The same key in both variables is a configuration error, and every
   service that reads them refuses to start.
2. Redeploy. The `migrate` log reports `re-sealed N under the current key`.
3. Clear `UPSTREAM_AUTH_PREVIOUS_KEYS` and redeploy again.

If a deploy's `migrate` log warns that a flock's upstream credential cannot be opened, nothing has
been lost. `migrate` never modifies a value it cannot open, so putting the right key back into
`UPSTREAM_AUTH_PREVIOUS_KEYS` and redeploying recovers it. Until then that flock's paddocks answer
`503 {"error":"upstream credential unavailable"}` rather than calling the flock without its
credential.

**Restoring a database backup taken under a different key** puts you in exactly that state: the
warning names each affected flock. Either add the key that was current when the backup was taken
to `UPSTREAM_AUTH_PREVIOUS_KEYS` and redeploy, or send each affected flock a new credential with
`PUT /api/admin/v1/flocks/{id}` and a fresh `upstreamAuth`. So keep retired keys with the backups
they can open.

**If `UPSTREAM_AUTH_KEY` itself may have leaked**, re-encrypting protects nothing: anyone holding
the key and a copy of the database can already read every credential. Revoke and reissue the
credentials **at each upstream server**. Then set a new `UPSTREAM_AUTH_KEY` with
`UPSTREAM_AUTH_PREVIOUS_KEYS` empty, redeploy, and send each flock its new credential with
`PUT /api/admin/v1/flocks/{id}`.

### Forcing everyone to sign in again

After a suspected leak, end all three kinds of sign-in: console sessions, sign-in service sessions,
and `mm` CLI sign-ins.

1. **Rotate `SESSION_SECRET`** (`openssl rand -hex 32`). Every console session cookie stops
   verifying, so every operator is signed out of the console.
2. **Replace `OIDC_COOKIE_KEYS`** with a single new key — replace, do not prepend. A prepended
   list still verifies cookies signed with the old key, so sign-in service sessions would
   survive and sign the browser straight back in.
3. Redeploy both services.
4. Optionally, delete the orphaned session rows. They can no longer be reached once the cookie
   keys change, and expire on their own within 12 hours:

   ```sql
   DELETE FROM oidc_payload WHERE model = 'Session';
   ```

5. **End every `mm` sign-in.** Steps 1 to 4 do not touch these. A CLI sign-in is a grant stored in
   the sign-in service's database, and its refresh token keeps renewing for up to 90 days whatever
   happens to the secrets above. Delete every refresh token and grant:

   ```sql
   DELETE FROM oidc_payload WHERE model IN ('RefreshToken', 'Grant');
   ```

   Each `mm` then has its next renewal refused and asks for `mm login`. The console holds no
   refresh tokens, so this step is for `mm` only. It also deletes the console's grants, which does
   no harm: the console's next sign-in creates a new grant, with no extra prompt. The step does not
   end **access tokens** already issued: those are signed JWTs that the console checks by itself
   and that are never stored, so each one keeps working until it expires, one hour after it was
   issued at most. To end them sooner, replace `OIDC_SIGNING_KEY` outright, as the next paragraph
   describes: the console then refuses them once its cached copy of the sign-in service's keys
   expires, within 10 minutes, or at once if you also restart the control-plane container.

If the leak may have included `OIDC_SIGNING_KEY`, **replace it outright**:

1. Set `OIDC_SIGNING_KEY` to a new key and make sure `OIDC_PREVIOUS_SIGNING_KEYS` is empty,
   clearing it if a rotation window left a key in it, since that key may be the leaked one.
2. Redeploy the sign-in service (`auth`), and wait until it is running with the new key.
3. **Then restart the control-plane container**, for example `docker compose restart control-plane`.
   Do this even if the control-plane was redeployed with the other secrets, unless that happened
   after step 2. The console keeps its copy of the sign-in service's published keys in the
   control-plane process's memory, for up to 10 minutes. Until that copy expires it still accepts
   admin API access tokens signed with the leaked key, including any forged with it. A restart
   drops the copy, so the leaked key stops verifying at once. Without the restart it stops within
   10 minutes.

Steps 2 and 3 together cover every place that verifies these tokens. The restart covers the
control-plane process, which holds two copies of the keys, both in memory: the admin API's, which
checks the access tokens clients present, and the console sign-in's, which checks only the ID token
the console receives straight from the sign-in service when someone signs in. The data plane
verifies no token from the sign-in service at all: it authenticates API keys. The sign-in service
reads its keys when it starts (step 2).

Do **not** run the overlap procedure in [Rotating the sign-in keys](#rotating-the-sign-in-keys)
here: its first step moves the old key into `OIDC_PREVIOUS_SIGNING_KEYS`, which would keep
publishing the *leaked* key for verification for the whole window. A leaked key must stop verifying
as soon as possible, and losing the in-flight tokens signed with it is the point.

### Upgrading to encrypted upstream credentials

This release stops storing flock upstream credentials in plaintext, and stops returning them from
any read. Before it, `GET /api/admin/v1/flocks` returned them to any token holding the `read`
scope.

1. **Add `UPSTREAM_AUTH_KEY`** (`openssl rand -base64 32`) to the stack's environment, and an
   empty `UPSTREAM_AUTH_PREVIOUS_KEYS`. Keep every other variable you already have.
2. **Replace the stack file** with the current one. It passes the key to `migrate`,
   `control-plane` and `data-plane`.
3. **Redeploy.** `migrate` renames `flock.upstream_auth` to `upstream_auth_enc`, encrypts each
   existing credential, logs how many it encrypted, and then rewrites the `flock` table
   (`VACUUM FULL`) so the old plaintext row versions are not left in its data files. If that
   rewrite fails, `migrate` still succeeds but logs a warning with the exact command to run by
   hand. Run it: a later deploy will not retry it.

Afterwards:

- **The API.** A flock is returned with `hasUpstreamAuth` in place of `upstreamAuth`. On
  `PUT /flocks/{id}`, omitting `upstreamAuth` now leaves the stored credential alone; send `null`
  to clear it.
- **There is no downgrade short of a database restore.** Older images read a column that no
  longer exists.
- **Backups taken before the upgrade still hold every credential in plaintext.** So do Postgres's
  write-ahead log and any WAL archive from before the upgrade, and any listing already fetched
  through the API. If any of those may have left your control, reissue the credentials at the
  upstream servers.

### Upgrading from 0.3.x

0.4.0 moves sign-in out of the console into the new `auth` service. An existing stack keeps its
database, its operators and its secrets; it only gains a service and five variables.

1. **Add only the new variables** to the stack's environment:

   | Variable | Value |
   |----------|-------|
   | `CONSOLE_CLIENT_SECRET` | `openssl rand -hex 32` |
   | `OIDC_COOKIE_KEYS` | `openssl rand -hex 32` |
   | `OIDC_SIGNING_KEY` | `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \| openssl base64 -A` |
   | `CONSOLE_URL` | The exact origin your browser uses for the console, e.g. `http://127.0.0.1:3200` |
   | `OIDC_ISSUER` | The exact origin your browser uses for the sign-in service, e.g. `http://127.0.0.1:3100` |

   **Do not paste a whole fresh `new-stack.sh` block.** It also generates a new
   `POSTGRES_PASSWORD`, which will not match the password already stored in the existing
   Postgres volume, and a new `LICENSE_KEY_SECRET`, which makes the stored licence key
   undecryptable. Keep every variable you already have.
2. **Replace the stack file** with the current `docker-compose.portainer.yml`; the `auth`
   service exists only there.
3. **Reach the sign-in service as well as the console.** Forward or publish the auth port
   (`AUTH_HOST_PORT`, default `3100`) alongside the console's, e.g.
   `ssh -L 3200:127.0.0.1:3200 -L 3100:127.0.0.1:3100 <host>`, or route it through the same
   proxy or tunnel. The browser must reach it at exactly `OIDC_ISSUER`.
4. **Set `TAG` to `0.4.0`** if your stack pins it, and redeploy.

What changes for operators:

- **Existing console sessions survive the upgrade.** The session cookie's format and
  `SESSION_SECRET` are unchanged, so nobody is signed out.
- **The console no longer has its own password form.** `/login` sends the browser to the
  sign-in service, which holds the form, and back.
- **Accepting an invite is now two steps:** set a password on the invite page, then sign in
  with it at the sign-in service.

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
