# M2 — the admin API: `/api/admin/v1/*`, the device-grant CLI, and the audit credential

**Status:** design settled; ready to plan. Amended during implementation — see §8. **Date:** 2026-09-22.
**Wayfinding map:** Kanboard #4471 (project 142) — cruxes #4472–#4481, #4488, all closed.
**Parent design:** [`2026-09-06-remote-control-surface-design.md`](2026-09-06-remote-control-surface-design.md)
— this spec settles that document's M2 row (§6) and its deferred §4.3 / §4.6 questions.
**Binding input:** the *"Handoff to M2 and M4"* section of
[`2026-09-15-m1-auth-foundation.md`](../plans/2026-09-15-m1-auth-foundation.md#L4211).

---

## 1. Why

M1 shipped an OpenID Provider and made the console a relying party (`v0.4.1`, Kanboard #4377). It
issues RFC 9068 JWT access tokens for a resource that nothing yet consumes. M3 typed
`toMcp(fence): McpToolDef[]` (Kanboard #4376). Between them there is still no way to create or edit
a domain object over the network: the control plane's only Route Handler remains
`GET /api/healthz`, and remote provisioning still means `docker exec` into the container with a
`tsx` script.

M2 closes that. It is the first consumer of M1's token contract, and M4's per-paddock MCP
authenticates against the same machinery, so the decisions here are load-bearing twice.

### What this milestone must not do

Carried forward, unchanged, and re-stated because M2 is where each could plausibly erode:

- **Consumer `mm_live_` keys never work for admin operations.** They are a consumer credential for
  the streaming proxy. Reusing them here would be privilege escalation by design.
- **Every mutation keeps its audit entry and its org scoping.** Handlers call the existing services;
  nothing reaches SQL directly.
- **The `mutate` route class stays permanently unexposable.**
- **Zero new runtime dependencies.** Everything below is buildable with what is installed.
- **No hardcoded hosts.** Every URL is configuration.

---

## 2. Decisions

| # | Crux | Decision | Kanboard |
|---|---|---|---|
| D1 | Route shape | Resource REST; **`PUT` = full replace**, no PATCH. Bare-JSON success, RFC 9457 `problem+json` errors | #4472 |
| D2 | Versioning | **`/api/admin/v1/*`**; `aud` stays `<console>/api/admin` | #4473 |
| D3 | Pagination | **Cursor + RFC 8288 `Link`**; body stays a bare array. Filtering = existing service scoping only | #4474 |
| D4 | Scopes | Keep the four capabilities. Bearer **always** sets a concrete `grants` Set | #4475 |
| D5 | CLI | Private `apps/cli`, public client, **device grant only**; rotating `offline_access`; 0600 XDG credentials | #4476 |
| D6 | Key rotation | `OIDC_PREVIOUS_SIGNING_KEYS`; one shared `createRemoteJWKSet` with explicit timings | #4477 |
| D7 | Audit | `credential` on `Actor`; `writeAudit(tx, actor, entry)`; `changed_by` structured text | #4478 |
| D8 | Key delete | `POST /keys/{id}/revoke`; `DELETE` → **405** | #4479 |
| D9 | Exposure & CSRF | **No bind change**; bearer required, bearer+cookie → 400, cookie-only → 401 | #4480 |
| D10 | OpenAPI | **3.1**, request-body schemas from `z.toJSONSchema()` (draft-2020-12; details in §8, A11); committed, CI-diffed, served unauthenticated | #4481 |
| D11 | Coverage | Exactly §6's list; users/invites/licence **not** exposed | #4488 |

### 2.1 Why `PUT` and never `PATCH` (D1)

`saveFlock` (and `savePaddock`, `saveFence`, `saveTemplate`) performs `set(values)` — a **replace**,
not a merge, with an optional `id` in the body selecting update over insert. Exposing `PATCH` would
either misdescribe that, or force a read-merge-write in the handler, outside the service's
transaction, where it races. `PUT` describes the existing behaviour exactly and costs nothing.

The services have no by-id read at all today. Each gains one — `getFlock`, `getPaddock`, … — placed
in the **service**, not the handler, so org scoping and `requireCapability` stay in one place.

Errors are `application/problem+json` (RFC 9457): `{type, title, status, detail}`, with a
`capability` member on a `ForbiddenError`. This maps 1:1 onto the existing
`ForbiddenError` / `NotFoundError` / `ZodError` triple, and adds no dependency.

### 2.2 Why `v1` in the path but not in the audience (D2)

`adminApiResource(consoleUrl)` returns `<console>/api/admin`. That string is simultaneously the
RFC 8707 resource indicator, the token `aud`, and — per the M1 handoff — a value imported from
`@metamodels/schema` and never re-typed. An RFC 8707 resource indicator covers its whole subtree, so
`/api/admin/v1/...` needs no audience change and `adminApiResource()` is not touched. Versioning the
audience instead would invalidate the `aud` of every already-issued token and move a contract M4
also consumes.

Going unversioned and adding `v1` later *is itself* the breaking change; one path segment now is
free. OpenAPI `info.version` is the contract's own version (`1.0.0`), maintained by hand in
`openapi.ts`: it moves when the document's contract does, independently of the path major and of
the release tag.

### 2.3 Why the bearer path always sets `grants` (D4)

C3's rule is `(MATRIX[role][action] ?? false) && (grants?.has(action) ?? true)`. The `?? true`
fallback exists so the console's cookie session behaves exactly as it does today. Left uniform, it
would mean an access token granted **no** capability scopes gets full role power — precisely the
Portainer impersonation trap C3 was written to avoid.

So: the bearer path resolves `grants` to a `ReadonlySet<Capability>` **always, even when empty**. An
unscoped token intersects to nothing and is denied per capability, naming the missing one in the
problem document. `grants: undefined` is reserved — by rule and by an explicit test — for the
console cookie session. Non-capability scopes (`openid`, `offline_access`) are filtered out before
the set is built.

The scope vocabulary stays exactly `CAPABILITIES` (`read`, `resource.write`, `user.manage`,
`license.manage`). The spec's motivating case — a token that may write resources but never manage
users or touch the licence — is already expressible; finer grain stays purely additive.

### 2.4 Why the CLI is interactive-only (D5)

RFC 8628's device grant is interactive by construction. Non-interactive CI is **explicitly out of
M2**, because `client_credentials` has no `sub`: `loadActiveActor` would have no user row to load
and C3 no role to intersect against. Giving it a subject means designing service-account identity —
a non-person `user` row with a seat, a role, an audit identity and a deactivation story. That is its
own milestone, not a rider on this one.

Pasting a human's refresh token into CI was rejected for the same reason in reverse: the pipeline
would act as a named person, and rotation would break it silently.

### 2.5 Why the exposure posture does not change (D9)

C2 put the admin API inside the console's Next process. `next start` takes one `-p` and one `-H`, so
there is one listener and `/api/admin/v1/*` cannot be published without publishing the console. The
admin API is therefore reached exactly as the console is: loopback plus a tunnel in production
(`${CONTROL_PLANE_BIND:-127.0.0.1}`), `0.0.0.0` in dev and the generic compose. No new variable, no
new default — widening the production posture inside the milestone whose token verification has
never seen real traffic is the wrong trade, and an operator who wants it public already has the knob.

### 2.6 A verified correction to the parent spec §4.3 (D10)

The parent spec stated that `zod/v4`'s `z.toJSONSchema()` produces `target: 'openapi-3.0'` output.
Checked against this repo (`zod@3.25.76`, Node 24.18.0):

```
$ node -e "const z=require('zod/v4');z.toJSONSchema(z.object({a:z.string()}),{target:'openapi-3.0'})"
Invalid target: openapi-3.0        # stderr — it does not throw, it falls through
```

`openapi-3.0` is not a recognised target in the `zod/v4` bundled with 3.25.76 (recognised:
`draft-2020-12`, `draft-7`). For a nullable field it emits `anyOf: [{type:'string'},{type:'null'}]`,
which OpenAPI **3.0 forbids** — 3.0 requires `nullable: true`.

The default output is clean draft-2020-12, and **OpenAPI 3.1's Schema Object *is* JSON Schema
draft-2020-12**. So M2 emits a 3.1 document from `z.toJSONSchema()`'s draft-2020-12 output: no
target string, no warning, still zero dependencies. That output is not published untransformed,
and it is not made from the repo's own schemas: §8, A11 records what the implementation does.
`@asteasolutions/zod-to-openapi` 8.x/9.x requires `zod@^4.0.0` and was never available.

The parent spec's §4.3 bullet now says 3.1 (§6).

### 2.7 Why half the scope vocabulary is deliberately inert (D11)

v1 covers exactly the parent spec §6 list — flocks, paddocks, fences, keys, templates, usage — the
provisioning surface the `docker exec` script already drives. `users`, `invites`, `license` and
`entitlements` are **not exposed**, so `user.manage` and `license.manage` are unreachable over the
admin API: a leaked CLI token cannot invite a user or touch the licence regardless of what it was
granted. Those scopes still gate the console path through C3.

Adding users would drag the seat-limit and last-admin guards — and their per-org `SELECT … FOR
UPDATE` lock — in front of a brand-new caller, plus invite-token flows that assume a browser. That
is a later milestone with its own risk budget.

---

## 3. The surface

All paths are relative to `/api/admin/v1`. Every handler resolves a bearer token to an `Actor`
carrying `grants`, then calls the named service unchanged.

| Method & path | Service | Capability |
|---|---|---|
| `GET /flocks` | `listFlocks` | `read` |
| `POST /flocks` | `saveFlock` (insert) | `resource.write` |
| `GET /flocks/{id}` | `getFlock` *(new)* | `read` |
| `PUT /flocks/{id}` | `saveFlock` (replace) | `resource.write` |
| `DELETE /flocks/{id}` | `deleteFlock` | `resource.write` |
| `GET /paddocks` | `listPaddocks` | `read` |
| `POST /paddocks` | `savePaddock` (insert) | `resource.write` |
| `GET /paddocks/{id}` | `getPaddock` *(new)* | `read` |
| `PUT /paddocks/{id}` | `savePaddock` (replace) | `resource.write` |
| `PUT /paddocks/{id}/status` | `setPaddockStatus` | `resource.write` |
| `DELETE /paddocks/{id}` | `deletePaddock` | `resource.write` |
| `GET /paddocks/{id}/fence` | `getFence` | `read` |
| `PUT /paddocks/{id}/fence` | `saveFence` | `resource.write` |
| `GET /paddocks/{id}/templates` | `listTemplates` | `read` |
| `POST /paddocks/{id}/templates` | `saveTemplate` | `resource.write` |
| `PUT /paddocks/{id}/templates/{tid}` | `saveTemplate` (replace) | `resource.write` |
| `DELETE /paddocks/{id}/templates/{tid}` | `deleteTemplate` | `resource.write` |
| `GET /keys` | `listKeys` | `read` |
| `POST /keys` | `createKey` | `resource.write` |
| `POST /keys/{id}/revoke` | `revokeKey` | `resource.write` |
| `DELETE /keys/{id}` | — | **405** |
| `GET /usage/matrix` | `usageMatrix` | `read` |
| `GET /usage/daily` | `dailySeries` | `read` |
| `GET /usage/top-keys` | `topKeys` | `read` |
| `GET /openapi.json` | — | **unauthenticated** |

**Paddock status** is a `PUT` sub-resource with body `{status}` (`PADDOCK_STATUS` =
`'active' | 'disabled'`) routed to `setPaddockStatus`, not a field of the main `PUT`. Folding it in
would require sending the whole paddock and would route through `savePaddock`, bypassing the reason
`setPaddockStatus` exists separately.

**Key revocation** is a `POST` action, not a `DELETE`, because three `usage_*` tables carry `key_id`
FKs with `ON DELETE CASCADE` — a real delete would silently destroy usage history — and `revokeKey`
only sets `status: 'revoked'`. `DELETE` means *gone* on flocks, paddocks and templates, which really
do hard-delete; it must not mean something softer here. Revoking an already-revoked key is
idempotent: 204, no second audit entry. The two shapes differ because a revoke is irreversible and
not a settable state, while paddock status is a reversible field.

**Usage** endpoints are read-only reports mirroring the service functions, taking the same
`startBucket`/`endBucket`/`dim`/`keyId`/`paddockId`/`limit` parameters and returning the same rows.
They make no pretence of being resources.

### 3.1 Pagination

`?limit=` (with a default and a hard maximum) and `?cursor=`. The response body stays a **bare JSON
array**; the next page rides in `Link: <…>; rel="next"` (RFC 8288), and simply does not appear on
the last page. This is the only shape that composes with the bare-JSON decision — pagination
metadata never enters the body, so no later change to it is breaking. Cursor encode/decode and the
stable sort key live in the services.

Filtering in v1 is limited to scoping the services already implement (`listTemplates`'s
`paddockId`). Query parameters are purely additive, so `?status=`, `?breed=` and `?sort=` remain
available later without a break.

### 3.2 Authentication and CSRF

Three cases, each tested:

1. valid `Authorization: Bearer`, **no** session cookie → proceed;
2. bearer **and** a session cookie → **400**, before any token verification. An ambient cookie on an
   admin call means a browser sent it — the confused-deputy shape Portainer rejects;
3. cookie only, or neither → **401**, stating that the admin API does not accept sessions.

Token verification is offline, per the M1 handoff: `typ: at+jwt`; `iss` = `OIDC_ISSUER`;
`aud` = `adminApiResource(CONSOLE_URL)` imported from `@metamodels/schema`, **accepting both a bare
string and an array** because M1 mints a string and RFC 9068 permits either; RS256 against
`${OIDC_ISSUER}/jwks`, fetched over `OIDC_INTERNAL_URL` with `onOrigin`, `kid` resolved and **never
pinned**.

---

## 4. Changes outside the routes

### 4.1 `Actor` gains a credential

```ts
export interface Actor {
  id: string; orgId: string; email: string; role: Role
  grants?: ReadonlySet<Capability>   // C3 — undefined ONLY on the cookie path
  credential: string                 // 'session' | `token:${clientId}:${jti}`
}
```

`authorize()` becomes the C3 intersection. Interactive console sessions pass `grants = undefined`
and behave exactly as today, so all 40 services keep calling `requireCapability(actor, cap)`
unchanged.

### 4.2 Audit gains `changed_by`

`audit_log.changed_by` is a **nullable `text`** column: `session` for the console cookie path,
`token:<client_id>:<jti>` for a bearer. Greppable, indexable, diffable in tests, and the `jti` makes
an individual token instance traceable so a later revocation can be correlated.

`writeAudit` changes shape to take the Actor: **`writeAudit(tx, actor, { action, target, detail })`**.
That is 19 mechanical edits across 8 services, and each call site gets *shorter* — today every one
of them writes `{ orgId: actor.orgId, actor: actor.email, … }`, both already derived from the Actor.
Afterwards `orgId`, `actor` and `changed_by` derive in exactly one place and cannot disagree, and a
missing credential is a compile error rather than a silent `null`.

Nullable with **no backfill**: rows written before M2 predate the concept, and `null` says exactly
that. New code never writes `null` — both paths always supply a value.

Rejected alternatives: an optional `changedBy?` field (a forgotten site silently writes `null`),
`AsyncLocalStorage`, and a per-request `Db` wrapper (ambient state, no compile-time signal, harder to
reason about under transactions).

### 4.3 Signing-key overlap

New optional **`OIDC_PREVIOUS_SIGNING_KEYS`** — comma-separated base64 PKCS#8 PEMs, validated by the
same checks as `OIDC_SIGNING_KEY` (RSA, ≥ 2048 bits) and appended **after** it in `signingJwks()`.
oidc-provider signs with the first matching key, so previous keys verify but never sign, and `kid`
is the RFC 7638 thumbprint so distinct keys get distinct `kid`s with no bookkeeping.

Rotation is **one edit**, made before any redeploy: move the current `OIDC_SIGNING_KEY` into
`OIDC_PREVIOUS_SIGNING_KEYS` **and** set the new `OIDC_SIGNING_KEY`, together. The two variables
must never hold the same key, because the auth service refuses to start on a repeated `kid`
(`apps/auth/src/keys.ts`). Redeploy, wait out the window, then clear `OIDC_PREVIOUS_SIGNING_KEYS`
and redeploy again. For the admin API the window is **70 minutes**: the 1 h access-token lifetime
plus the verifier's 10-minute JWKS cache. The operator procedure is
[Rotating the sign-in keys](../../DEPLOY.md#rotating-the-sign-in-keys). This is the M1 handoff's
*"publish the previous key alongside the new one"*, discharged.

On the verifying side: exactly **one process-wide `createRemoteJWKSet`**, mirroring what
`oidc-session.ts` already does for the console's client, with `cacheMaxAge` and `cooldownDuration`
**set explicitly** rather than left to `jose`'s defaults — the rotation window should be a number in
our configuration, not a library default nobody has read. A test asserts an unknown `kid` triggers
at most one refetch per cooldown.

### 4.4 The CLI and the device grant

A new private workspace app **`apps/cli`**: zero-dependency Node-native TypeScript (Node ≥ 24 strips
types), run as `pnpm --filter @metamodels/cli start -- <cmd>`. Publishing it with a `bin` stays a
pure addition later. Bundling it into the control-plane image was rejected — that reproduces exactly
the `docker exec` problem M2 exists to remove.

- **OAuth client:** public (no secret), no redirect URIs, `urn:ietf:params:oauth:grant-type:device_code`
  plus `refresh_token`, statically registered alongside the console. No PKCE: RFC 8628 has none
  (§8, A1).
- **Lifetime:** requests `offline_access`; refresh tokens **rotate** (each use issues a new one and
  invalidates its predecessor, so reuse detects theft), bounded by an idle window (~30 days) and an
  absolute cap (~90 days). Access tokens stay 1h from the resource server. The console's 12h
  `OPERATOR_SESSION_TTL_MS` is untouched — it caps a *browser* session, for a reason that does not
  apply to a CLI.
- **Storage:** `$XDG_CONFIG_HOME/metamodels/credentials.json` (default `~/.config/metamodels/`),
  **keyed by issuer** so several boxes coexist, written `0600`, mode asserted on every read and the
  file refused if it is group- or world-readable. The same shape `gh`, `docker` and `kubectl` use.
  An OS keychain was rejected: a native dependency against the zero-dep norm, with a headless-Linux
  fallback needed anyway.

The auth service gains the device-authorization endpoint, a user-code entry view and a device
verification view, reusing the M1 interaction flow and its CSP.

**The CLI is the second registered client.** The M1 handoff is explicit: `makeGetResourceServerInfo`
currently lets *any* client ask for the admin-API resource, and must start gating on its third
argument the moment a second client exists. That gate is part of this milestone, not a follow-up.

### 4.5 OpenAPI

A script generates **`docs/api/openapi.json`** — OpenAPI **3.1**. Its request-body schemas come from
`z.toJSONSchema()`'s draft-2020-12 output, and its response schemas are hand-written; §8, A11 has
the details. The file is committed, so every change to the API
shape is a reviewable diff in the PR, and **CI regenerates it and fails if it is stale**. The same
document is served at `GET /api/admin/v1/openapi.json`, **unauthenticated**: the repo is AGPL and
public, so the shape is not a secret, and an unauthenticated schema is what lets a client bootstrap
before it holds a token.

No docs UI. Every zero-dependency renderer is a CDN script tag — a third-party origin in the
console's CSP and a page that breaks on an air-gapped box.

---

## 5. Non-goals

- **Non-interactive / CI authentication.** No `client_credentials`, no service accounts, no
  long-lived static admin token. §2.4.
- **Users, invites, licence and entitlements over HTTP.** §2.7.
- **`mm_admin_` keys.** Designed under C3, dropped under C8; not revived here.
- **A network boundary.** C2 decided this separation is per-route authorization. No second listener,
  no reverse-proxy split, no third deployable.
- **`mutate` routes.** Permanently unexposable, here as everywhere.
- **Rate limiting on the admin API.** The surface is loopback-by-default and token-gated; a limiter
  is a later decision, not an M2 rider.
- **Database-held signing keys.** `OIDC_PREVIOUS_SIGNING_KEYS` discharges the M1 handoff; a rotation
  subsystem is separate work.
- **Sorting, general filter grammars, and offset pagination.** §3.1.
- **Implementation.** This spec decides; `kanboard:plan` sequences; execution follows.

---

## 6. Amendment to the parent spec (made 2026-09-22)

[`2026-09-06-remote-control-surface-design.md`](2026-09-06-remote-control-surface-design.md) §4.3
stated that OpenAPI is generated with `target: 'openapi-3.0'`. That target is unrecognised on
`zod@3.25.76` and its output is illegal 3.0. Commit `d45ef73` amended the bullet to **OpenAPI 3.1**,
generated with `z.toJSONSchema()`'s draft-2020-12 output, and added a row for it to that spec's
amendments table. See §2.6 for the verifying command, and §8, A11 for how the schemas are built.

---

## 7. Verification standard

Per house rules, no milestone claims completion without command output proving it. For M2 that means,
at minimum:

- A real device-grant login from `apps/cli` against a throwaway stack, ending in a token written
  `0600`, followed by a create-read-replace-delete cycle over `/api/admin/v1/*`.
- The negative cases: no token → 401; bearer **and** cookie → 400; cookie only → 401; a token whose
  `aud` is not `adminApiResource(CONSOLE_URL)` → 401; an unscoped token → 403 naming the capability;
  a `viewer` role with `resource.write` granted → 403 (the intersection, not either side alone).
- `DELETE /api/admin/v1/keys/{id}` → 405, and `POST …/revoke` → 204 with a `key.revoke` audit row
  carrying `changed_by = token:metamodels-cli:<jti>`.
- A rotation exercise: sign with a new `OIDC_SIGNING_KEY` while the old one sits in
  `OIDC_PREVIOUS_SIGNING_KEYS`, and show a token minted before the rotation still verifies.
- `docs/api/openapi.json` regenerating byte-identically in CI.

Every compose command passes an explicit `-p` project name and non-default host ports: a real
operator stack runs on this machine under the default project name, with host ports 3000/8787/3200
in use and 3100 held by another process.

**Two items were not met literally** (disclosed 2026-09-23):

- *An unscoped token → 403 naming the capability* is proven by the route-handler tests
  (`admin-flocks.test.ts` and `admin-paddocks.test.ts`, "a token with no capability scopes is 403"),
  which call the handlers with a signed token carrying no capability scope. It is not part of the
  end-to-end run: `mm login` refuses an empty `--scope`, so the least-privileged token the e2e spec
  holds is a `read`-only one.
- *The rotation exercise* was run at commit `0292399`. From there to `32bf88e`, the runtime source
  changed only in comments. The final fix round then changed runtime code (config invalidation after
  admin mutations, the `Link` target, `mm` argument and error handling), but none in
  `apps/auth/src` or `admin-token.ts`, the signing and verification code the exercise tests.

---

## 8. Amendments (implementation, 2026-09-22 – 2026-09-23)

Where the built milestone differs from, or goes beyond, the text above. Each row was checked
against the code on `claude/m2-admin-api`. **Owner** is a decision Carmelo made; **controller** is a
ruling recorded in the M2 execution ledger; **spec, as built** is a behaviour this spec required,
where the row records the shape the implementation gave it. A1 and A11 are also corrected in place
(§4.4; D10, §2.6 and §4.5), as are two passages that were wrong rather than changed: §2.2's
`info.version` and §4.3's rotation steps. The operator documentation for each behaviour is
[`docs/admin-api.md`](../../admin-api.md).

| # | § | Was | Now | Why | Decided by |
|---|---|---|---|---|---|
| A1 | 4.4 | The CLI client uses PKCE | No PKCE. `cliClient()` is public (`token_endpoint_auth_method: 'none'`), with no redirect URIs and no response types | RFC 8628 defines no PKCE, and oidc-provider requires PKCE only at the authorization and PAR endpoints, and checks it only in the authorization-code grant, none of which the CLI uses | Controller |
| A2 | 4.4 | ~90-day absolute cap (the plan put it in `rotateRefreshToken`) | The cap is `ttl.RefreshToken` = `refreshTokenTtl`: `min(30d, iiat + 90d − now)`. `iiat` is the chain's first issue time, copied on every rotation. `ttl.Grant` = 90 d + the device-code TTL (was 14 d), so the grant outlives the cap | A `false` from `rotateRefreshToken` only stops rotation: the presented token is reused until its own `exp`, so a cap there is 90 + 30 days (plan defect 12-C). A grant shorter than the cap would end every CLI sign-in first | Controller |
| A3 | 4.4 | "Gate on the third argument" | `makeGetResourceServerInfo(servers, allowedByClient)`: a resource must be declared *and* listed for the requesting client, or `invalid_target`. A client not in `resourcesByClient` gets no resource. The console keeps its M1 admin-API access | The gate runs on every mint path (authorization, device authorization, token, refresh), so a new client is refused by default rather than trusted by default | Spec, as built |
| A4 | 4.4 | Device approval reuses the M1 interaction flow | **Every device approval asks for the password**, even with a live OP session (`device_fresh_login` check). The confirm page shows the **requesting machine's IP and user agent**. See [Signing in with the CLI](../../admin-api.md#signing-in-with-the-cli) | RFC 8628 §5.4 remote phishing: with a live session, one click minted a 90-day admin CLI chain for whoever sent the link | Owner |
| A5 | 4.4 | — | `verification_uri_complete` opens **our** code-entry page with the code prefilled and a visible Continue button, under the unchanged strict CSP. Two route intercepts (`device-middleware.ts`: prefill on `GET /device`, account switch on `device_resume`) replace oidc-provider pages that rely on inline script | Those library pages render blank under `default-src 'none'`. The intercepts depend on oidc-provider internals, pinned to `~9.12.2` and by tests | Owner (prefill); the switch page follows from A4 |
| A6 | 4.4 | — | **A new grant per device approval** (`loadExistingGrant` skips the session's grant on device routes). Signing one machine out, or re-logging in on it, signs no other machine out. See [Signing out](../../admin-api.md#signing-out) | A grant shared by every machine approved in one browser made any revocation all-or-nothing. This project's decision, not an RFC 8628 requirement | Controller |
| A7 | 4.4 | — | **OP token revocation is enabled** (RFC 7009, a client revokes only its own tokens). `mm logout` revokes the refresh token before deleting it; a re-login revokes the one it replaces | Without it, logout only deleted a file and left a 90-day refresh chain valid for anyone holding a copy | Controller |
| A8 | 4.4 | — | **The CLI refuses plain `http://` beyond loopback** unless `--allow-insecure-http` or `METAMODELS_ALLOW_INSECURE_HTTP=1`, for the issuer, the console, the three OP endpoints it uses (token, device authorization, revocation) and the verification URIs. See [Plain http](../../admin-api.md#plain-http) | The CLI sends bearer and refresh tokens, and the operator types a password into the verification page | Controller |
| A9 | 3.2, 4.3 | — (unknown `kid` unspecified) | **Unknown signing key → 401**, unless the verifier's key set is inside jose's cooldown (fetched < 30 s ago) → **503 `Retry-After: 30`**. An expired token is 401 before any key lookup. `mm` refreshes before sending a token with < 30 s left. See [Authentication](../../admin-api.md#authentication) and [Rotating the token-signing key](../../admin-api.md#rotating-the-token-signing-key) | Reverses a Task 3 ruling (always 503): the end-to-end rotation run showed every retired-key token failing with 503 after a by-the-book rotation, so an idle CLI never renewed | Controller |
| A10 | 1 | — | **`GET /flocks` and `GET /flocks/{id}` return `upstreamAuth` in plain text** to any token with `read`. Shipped documented ([Routes](../../admin-api.md#routes)); the fix — sealed at rest, never returned — is its own milestone on branch `feat/encrypt-upstream-auth` | Encrypting it needs a migration, a console change and a key-management decision: not an M2 rider | Owner |
| A11 | 2.6, 4.5, D10 | The schemas are `z.toJSONSchema()`'s default output, placed in `components.schemas` untransformed | **Request bodies** are rendered from five `zod/v4` **mirrors** of the repo's v3 input schemas (`saveFlockInput`, `savePaddockInput`, `saveFenceInput`, `createKeyInput`, `templateDraftSchema`), with `z.toJSONSchema(mirror, { io: 'input' })` and no `target`. `$schema` is deleted, and every `pattern` that sits beside a `format` is dropped (`dropFormatPatterns`). Two results are published as components and `$ref`ed as they are (`CreateKeyInput`, `TemplateDraft`); the other three are used only after a field is removed or per-field prose is layered on. The parity suite in `openapi.test.ts` holds each mirror to its v3 source: the same fields, optionality, required set and default values, and the same accept/reject verdict on probing payloads. **Response schemas**, parameters and headers are hand-written in `openapi.ts` | v4's `toJSONSchema` reads `schema._zod.def`, which a v3 schema does not have (it throws a `TypeError`), and `zod@3.25.76` has no v3-to-v4 bridge; adding one is a dependency. `io: 'input'` keeps a defaulted field out of `required` and leaves out `additionalProperties: false`, since these objects strip unknown keys rather than refuse them. v4's format patterns are stricter than the v3 checks that run (its uuid pattern demands a version nibble). A drizzle row is not a Zod schema, so responses have nothing to generate from | Controller (Task 10) |
