# Remote control surface — unified OIDC auth, admin API, per-paddock MCP

**Status:** design settled; M1, M2 and M3 planned. Amended 2026-09-15 and 2026-09-22 — see §7. **Date:** 2026-09-06.
**Wayfinding map:** Kanboard #3871 (project 142).
**Research:** [`2026-09-06-mcp-remote-research.md`](../briefs/2026-09-06-mcp-remote-research.md) ·
[`2026-09-06-admin-api-patterns-research.md`](../briefs/2026-09-06-admin-api-patterns-research.md)

---

## 1. Why

MetaModels has no way to create or edit any domain object over the network. Verified, not assumed:

- The control plane's only HTTP route handler is `GET /api/healthz`
  (`apps/control-plane/src/app/api/healthz/route.ts`). Everything else is Next.js **server
  actions** across nine `actions.ts` files — POSTs with encrypted, non-deterministic action IDs
  that are regenerated per build. Next's own documentation treats Route Handlers, not server
  actions, as the public HTTP surface.
- The data plane exposes `/healthz`, `/readyz`, `GET /p/:slug/result/:jobId`, and the catch-all
  `ALL /p/:slug/*`. No admin surface.

So the only programmatic path today is `docker exec` into the control-plane container running a
`tsx` script against the `*-service.ts` functions. "Remote" means shell access to the host.

Separately, an MCP seam has been dormant since v1: `packages/connectors/src/breed.ts:107` declares
`toMcp?(fence: C): unknown[]`, implemented by neither breed. The original design specified it as
`toMcp?(fence: C): McpToolDef[]` and listed it under *"Out of v1 (deferred, with the seam that makes
it additive)"* — the `unknown[]` in code is a degraded copy of the intended type.

These are two different surfaces on two different axes — **operator-facing** provisioning and
**consumer-facing** tool exposure. This spec covers both, because their hard part is the same one:
authentication. Deciding it twice would produce two incompatible token systems.

### What changed the design

Premises the work started from, checked against the repo:

| Premise | Reality |
|---|---|
| Control plane binds `127.0.0.1`, so an admin API would weaken that posture | **True for production only.** The Portainer stack binds `"${CONTROL_PLANE_BIND:-127.0.0.1}:…"` (`docker-compose.portainer.yml:90`) — loopback by default, deliberately, reached over a tunnel. The dev and generic files publish `"${CONTROL_PLANE_PORT:-3000}:3000"` with no host-IP prefix, i.e. `0.0.0.0` (`docker-compose.yml:56`, `docker-compose.deploy.yml:50`), and Docker documents that published ports bypass `ufw`. *Amended 2026-09-15: the original row missed the Portainer file and said there was no loopback posture to preserve.* |
| Adding an MCP SDK would break the zero-dependency norm for MCP's sake | The norm breaks for **OAuth**, not MCP. Under spec `2026-07-28` a minimal MCP server is three JSON-RPC methods over one POST route. |
| `toMcp?(fence)` is the right shape, merely unwired | **Correct.** ComfyUI templates are embedded in the fence, so `toMcp(fence)` serves both breeds; only the `unknown[]` return type is wrong (§4.4). *Amended 2026-09-15: the original row claimed the signature could not serve ComfyUI — that was false.* |

### MCP specification baseline

Verified against primary sources; current revision is **`2026-07-28`**, and it is materially
different from earlier revisions:

- **No handshake, no protocol session.** *"Earlier protocol revisions established a connection-scoped
  session with an `initialize` handshake and allowed servers to initiate JSON-RPC requests."*
  Version negotiation is now per-request via `_meta.io.modelcontextprotocol/protocolVersion`,
  mirrored to the `MCP-Protocol-Version` header on Streamable HTTP. `server/discover` is a mandatory
  RPC that clients may optionally call.
- **The tool list may vary by credential.** The set *"**MUST NOT** vary per-connection or as a side
  effect of other requests on the connection. The set **MAY** vary by the authorization presented on
  the request … since credentials are per-request input, not connection state."* This is exactly the
  fence-derives-tools model the v1 design guessed at, and it makes `toMcp` conformant by design.
- **Authorization is `OPTIONAL`** — but once adopted over HTTP, RFC 9728 becomes a MUST, and RFC 7591
  Dynamic Client Registration is **deprecated** in favour of Client ID Metadata Documents.
- **No token passthrough.** *"MCP servers **MUST** only accept tokens that are valid for use with
  their own resources. MCP servers **MUST NOT** accept or transit any other tokens."*
- **Annotations are not policy.** *"clients **MUST** consider tool annotations to be untrusted."*
  Enforcement stays in `guard()`; an annotation is never read as permission.

---

## 2. Decisions

| # | Crux | Decision | Rationale |
|---|---|---|---|
| C1 | One surface or two | **Both**, one spec, staged | Auth is the shared hard part |
| C2 | Admin API home | **Control-plane Route Handlers** `/api/admin/*` | Service layer is app-private; `next start` takes one `-p`/`-H` |
| C3 | Token authorization | **role ∩ grants** intersect | Avoids the Portainer impersonation trap |
| C4 | MCP home + shape | **Data plane, per-paddock** `/p/<slug>/mcp` | Data plane already holds the fence |
| C5 | MCP auth | **Full OAuth 2.1** | Unlocks Claude.ai and ChatGPT connectors |
| C8 | AS source & absorption | **Embed `oidc-provider`**, **full unification**, **separate `auth` service** | Certified; Koa cannot mount in Next |
| C6 | `toMcp` fate | **Keep `toMcp(fence)`, type the return** as `McpToolDef[]` | Templates already ride in the fence. *Amended 2026-09-15 — first decided as "reshape" on a false premise, re-decided by the operator* |
| C7 | Staging | **Four milestones** | M1 is load-bearing for M2 and M4 |

### 2.1 Why the admin API lives in the control plane (C2)

The service layer is **app-private** — `apps/control-plane/src/server/`, 40 files. The data plane
shares only `@metamodels/connectors` and `@metamodels/schema`. Any other home pays a 40-file
extraction before a single feature ships. `next start` accepts one `-p` and one `-H`, so Next.js
structurally cannot open a second listener; a Kong-style split admin port needs a third deployable.

Kong is the **only** surveyed system with a genuinely separate admin listener. LiteLLM, Grafana,
Vault and Portainer are all single-port. One port, two credential classes, strict per-route
authorization is the majority pattern.

**Consequence to carry:** separation here is per-route authorization, **not** a network boundary.

### 2.2 Why the token carries its own authority (C3)

Portainer's access token resolves to its owner's `{ID, Username, Role}` — permanent full-power
impersonation, with revocation as the only control. Grafana service accounts, Vault tokens and
LiteLLM keys all carry their own authorization. MetaModels drifts into Portainer's design by
default if a token merely rehydrates the minting user's `Actor`.

`apps/control-plane/src/auth/authorize.ts` today:

```ts
export type Capability = 'read' | 'resource.write' | 'user.manage' | 'license.manage'
export interface Actor { id: string; orgId: string; email: string; role: Role }
export function authorize(user: { role: Role }, action: Capability): boolean {
  return MATRIX[user.role]?.[action] ?? false
}
```

becomes an intersection, with grants sourced from OAuth scopes:

```ts
export interface Actor { id: string; orgId: string; email: string; role: Role; grants?: ReadonlySet<Capability> }
export function authorize(user: { role: Role; grants?: ReadonlySet<Capability> }, action: Capability): boolean {
  return (MATRIX[user.role]?.[action] ?? false) && (user.grants?.has(action) ?? true)
}
```

Interactive console sessions pass `grants = undefined` and behave exactly as today, so the change is
**additive**: all 40 services keep calling `requireCapability(actor, cap)` unchanged. This is what
makes a CI token that may write resources but never manage users or touch the licence expressible —
which a role-carrying token cannot express, because "write resources but not users" *is* the
`member` role.

### 2.3 Why one OpenID Provider for everything (C5, C8)

Full OAuth 2.1 was chosen over a static bearer because the target is a public `api.metamodels.cc`,
and a static bearer — while conformant, since authorization is `OPTIONAL` — reaches Claude Code,
VS Code, Cursor, Gemini CLI and the OpenAI Responses API but **forecloses ChatGPT connectors and
reaches Claude.ai/Desktop only through an org-gated beta**. Those are the mainstream consumer path.

`oidc-provider` is adopted rather than hand-rolled. Supply-chain vetting (per CLAUDE.md, before it
entered this spec):

| Check | `oidc-provider@9.12.2` |
|---|---|
| Install scripts | **none** (`scripts: []`) |
| Provenance | `attestations` + `signatures` present |
| Maintainers | sole, `panva` — also authors `jose`, `openid-client`; no ownership change |
| Direct deps | 3 — `debug`, `jose ^6.2.10`, `koa ^3.2.1` |
| Transitive | 39 packages, all koa's tree; deps.dev lists no advisories for `oidc-provider`, `koa` or `jose` (checked 2026-09-15) |
| Licence | MIT — compatible with AGPL-3.0 |

The repo's existing `.npmrc` (`minimumReleaseAge=1440`, `blockExoticSubdeps=true`) already quarantines
fresh publishes. **Pin with `~`, not `^`**: panva states experimental features — which includes the
CIMD support this design depends on — ship breaking changes in *minor* versions.

Two integration facts govern the shape:

1. **It does not authenticate users.** The integrator supplies `findAccount` and the login/consent
   interaction. `auth/password.ts` and `auth/login-throttle.ts` therefore **survive**, moved behind
   the OP's interaction flow. `auth/authorize.ts` is untouched apart from §2.2. The library **adds**
   a subsystem; it replaces nothing that exists.
2. **It is a Koa application.** Mountable to *"connect, express, fastify, hapi, or koa"* — Next.js is
   absent from that list, and App Router hands you Web `Request`/`Response`, not Node `req`/`res`.
   This is why the OP runs as its own service rather than inside the console.

**Beyond MCP**, the OP unlocks RFC 8628 device grant (headless CLI login — the right UX for a
self-hosted box), RFC 9449 DPoP, and RFC 7009/7662 revocation and introspection. It also closes a
seam the v1 design deferred explicitly: *"Multi-tenant SaaS … `org` FK on every entity; **only auth
stays single-operator**"*. Auth was the blocker; this removes it.

### 2.4 Why per-paddock MCP (C4)

The data plane already holds the fence at request time — `configStore.getPaddockBySlug()`
(`apps/data-plane/src/app.ts:107`), cached and invalidated by Redis pubsub from the control plane's
`config-publisher.ts`. `toMcp` needs **no new data access**, and inherits key auth, rate limit,
quota, `guard()` and metering unchanged.

Per-paddock over a single global `/mcp` because a Paddock is already the unit of publication,
`mm_live_` keys are already paddock-scoped, and per-paddock metering stays exact — a global endpoint
makes it ambiguous which paddock a call bills to. The spec's canonical-URI rules explicitly permit
this, listing `https://mcp.example.com/server/mcp` as valid *"when path component is necessary to
identify individual MCP server"*, and warn that aggregators must solve tool-name collisions.

---

## 3. Auth model, end state

```
                    ┌──────────────────────────┐
                    │  auth  (new service)     │   issuer: https://auth.<host>
                    │  oidc-provider on Koa    │   AS · OIDC · device grant · CIMD
                    └───────────┬──────────────┘
                     tokens     │
        ┌───────────────────────┼────────────────────────┐
        ▼                       ▼                        ▼
 ┌─────────────┐        ┌──────────────┐         ┌────────────────┐
 │ console     │        │ admin API    │         │ MCP endpoint   │
 │ (RP)        │        │ /api/admin/* │         │ /p/<slug>/mcp  │
 │ control-pl. │        │ control-pl.  │         │ data-plane     │
 └─────────────┘        └──────────────┘         └────────────────┘
                              RS                        RS
                                          ┌────────────────────────┐
                                          │ ALL /p/:slug/*  proxy  │
                                          │ mm_live_ keys — UNCHANGED
                                          └────────────────────────┘
```

- **One credential system** for console, admin and MCP: tokens from the OP.
- **`mm_live_` consumer keys are unaffected.** They remain the credential for the streaming proxy.
  They are a *consumer* credential and were never a candidate for admin use — reusing them would
  have been privilege escalation by design.
- **`mm_admin_` is never built.** It was designed under C3 and dropped under C8 once a real AS
  existed. C3's intersect rule survives; grants are sourced from scopes.
- Both resource servers **MUST** validate token audience (RFC 8707 §2) and **MUST NOT** accept or
  transit tokens issued for anything else.

---

## 4. Changes

### 4.1 New `auth` service

A fourth compose service running `oidc-provider` on its own Koa listener with a stable issuer URL.
Requires a Drizzle-backed storage `Adapter`, `findAccount`, and login/consent interaction views that
reuse the existing password and throttle code. Enable RFC 8707 resource indicators, RFC 9207 `iss`,
and CIMD; **do not** build DCR as the primary registration path — it is deprecated.

**Staged (amended 2026-09-15).** M1 enables resource indicators, JWT access tokens and `iss`, and
serves only statically registered first-party clients, whose consent is automatic. CIMD and a real
consent screen land in M4, where MCP clients first exercise them — until then any non-first-party
consent prompt is refused with `access_denied`. The device grant lands in M2 with the admin CLI. The
adapter is Postgres-backed (`oidc_payload`), matching the rest of the system of record.

### 4.2 Console becomes a relying party

**Amended 2026-09-15.** The console keeps a local session: `auth/session.ts` stays, as the relying
party's session codec. The original text said it would be retired in favour of the OP session, but a
relying party on its own origin cannot read the OP's cookie — every OIDC RP keeps a local session.
What leaves the console is password handling: the login form, `verifyLogin` and the login throttle
move behind the OP's interaction flow, and a console session is only ever minted from a verified ID
token. `hashPassword` stays shared, because seeding and invite acceptance still set passwords.
This is the highest-risk change in the programme: it is the one path that must never break.

### 4.3 Admin API

Route Handlers under `/api/admin/*` covering flocks, paddocks, fences, keys, templates and usage —
scoped to what the proven provisioning script already drives. Every handler resolves a token to an
`Actor` carrying `grants`, then calls the existing services unchanged, inheriting org scoping,
the per-org `FOR UPDATE` lock, transactions and audit.

Three supporting changes:

- **Audit gains a `changed_by` credential column.** Kong correlates `/audit/requests` with
  `/audit/objects`; LiteLLM records `changed_by_api_key`. MetaModels has only the object half. The
  moment two credential classes can mutate, the trail must say *which* one acted.
- **CSRF posture is bearer-only, no cookie fallback.** Server actions get an automatic Origin-vs-Host
  check; Route Handlers get nothing. Reject any request presenting both a bearer token and a session
  cookie, as Portainer does.
- **Keys have no hard delete.** `revokeKey` (in `keys-service.ts`) only sets `status: 'revoked'`
  and no key delete exists, while flocks, paddocks and templates hard-delete. The admin API must
  define `DELETE` semantics for keys explicitly rather than inherit the asymmetry. *(Surfaced
  2026-09-15 by the provisioning-plugin port, whose teardown tripped on it.)*
- **The OpenAPI document is generated, not written by hand.** Verified: `zod@3.25.76` resolves for all four packages,
  and the permanently-available `zod/v4` subpath exports `z.toJSONSchema()`, whose default output is
  JSON Schema draft-2020-12 — which *is* the OpenAPI **3.1** Schema Object. So the document is
  OpenAPI 3.1, its schemas generated with `z.toJSONSchema()` (draft-2020-12; details in M2 §8,
  A11). **Zero new
  dependencies.** Every `@asteasolutions/zod-to-openapi` 8.x/9.x requires `zod@^4.0.0`, which
  `3.25.76` does not satisfy. *(Amended 2026-09-22. This bullet claimed `target: 'openapi-3.0'`
  output. On `zod@3.25.76` that target is unrecognised — `Invalid target: openapi-3.0` on stderr,
  no throw — and a nullable field comes out as `anyOf` with `{type: 'null'}`, which OpenAPI 3.0
  forbids. The M2 spec's §2.6 records the check.
  `apps/control-plane/scripts/gen-openapi.ts` generates `docs/api/openapi.json`, and CI
  (`.github/workflows/ci.yml`) regenerates it and fails when the committed document is stale.)*

### 4.4 Breed contract

```ts
toMcp?(fence: C): McpToolDef[]
```

Only the return type changes — `unknown[]` becomes `McpToolDef[]`, the type the v1 spec specified.

**Amended 2026-09-15.** This section originally reshaped the hook to take `{ fence, templates,
paddock }`, claiming `toMcp(fence)` could not serve ComfyUI because templates live in the separate
`workflow_template` table. That was wrong. `templates-service.ts` writes templates into
`fence.constraint_json.templates`, `comfyuiBreed.handle()` reads `fence.templates`, and the data
plane already receives them inside `ResolvedPaddock.fence.constraintJson`. The `workflow_template`
table is not read at runtime. No config-publisher or config-store change is needed.

Embedded templates carry `id`, `graph`, `params` and `cost` but no display name, so ComfyUI tool names
derive from the template id.

### 4.5 MCP endpoint

`/p/<slug>/mcp` on the data plane, Streamable HTTP. Minimum surface: `server/discover`, `tools/list`,
`tools/call`. Requirements that follow from the spec:

- `tools/list` derives from the fence for the **presented credential**; `cacheScope` must be
  `private`, and ordering deterministic (the spec ties deterministic order to client caching and
  LLM prompt-cache hit rates).
- `mutate`-class routes are never emitted as tools. This remains a product guarantee.
- Enforcement stays in `guard()`. Annotations are advisory and untrusted.
- ComfyUI's async jobs use the spec's **Stateful Tools** pattern — an opaque handle returned from a
  creation tool, authorization revalidated on every call, bounded lifetime. This is already the shape
  of `GET /p/:slug/result/:jobId`.
- RFC 9728 Protected Resource Metadata served for both resource servers.

### 4.6 Exposure posture

**Amended 2026-09-15.** Production (Portainer) binds the console to loopback by default and expects
a tunnel; only the dev and generic compose files bind `0.0.0.0`. M1 gives the new `auth` service the
same loopback default in production (`AUTH_BIND`). Whether the admin API and the OP become publicly
reachable is decided in M2 (admin API) and M4 (MCP clients must reach the OP), not inherited.

**Amended 2026-09-22.** M2 decided the admin API's half: it **inherits the console's bind,
unchanged**. `/api/admin/v1/*` is served by the console's own Next listener, so it cannot be
published without the console. Production stays loopback plus a tunnel
(`${CONTROL_PLANE_BIND:-127.0.0.1}`), with no new variable and no new default. See
[M2 spec §2.5, D9](2026-09-22-m2-admin-api-design.md#25-why-the-exposure-posture-does-not-change-d9).
Whether the OP becomes publicly reachable is still M4's decision.

`api.metamodels.cc` currently resolves to `168.231.74.113`, not the GPU host, so every public URL
(`OIDC_ISSUER`, `CONSOLE_URL`) is configuration — never derived and never hardcoded.

---

## 5. Non-goals

- **`mutate` routes remain permanently unexposable** — `/api/pull`, `/api/delete`, and friends. Not
  configurable, in MCP or anywhere else.
- **No multi-operator SaaS in this programme.** The OP *unblocks* it; building it is separate work.
- **`mm_live_` consumer keys are not redesigned.** The proxy path is untouched.
- **No admin MCP server.** Operator tools (`create_paddock`, `list_flocks`) were considered and
  explicitly not chosen; MCP here is a consumer surface.
- **No implementation.** This spec decides; `kanboard:plan` sequences; execution follows.

---

## 6. Sequencing

| M | Milestone | Contents |
|---|---|---|
| **M1** | Auth foundation | `auth` service (oidc-provider, Postgres adapter, `findAccount`, login view, first-party auto-consent, resource indicators + the JWT access-token contract); console cut over to relying party — password login leaves the console, `session.ts` stays as the RP session |
| **M2** | Admin API | `/api/admin/*` Route Handlers, scopes ∩ role, audit `changed_by`, key-delete semantics, device grant for the admin CLI, OpenAPI from Zod, bind/exposure decision. *Non-interactive/CI auth explicitly deferred (M2 spec §2.4, D5); users, invites and licence not exposed in v1 (M2 spec §2.7, D11)* |
| **M3** | Breed prep | `toMcp` return typed as `McpToolDef[]`; both breeds implement |
| **M4** | MCP endpoint | `/p/<slug>/mcp`, Streamable HTTP, RFC 9728 on both resource servers, CIMD, consent screen |

M1 is load-bearing — M2 and M4 both authenticate against it. M3 is independent of M1/M2 and may run
in parallel if capacity allows.

### Risks

- **M1 touches the one path that must never break.** Console login has no fallback once password
  login leaves the console. Consider proving the OP alongside the existing login before cutting over.
- **CIMD is experimental upstream.** Breaking changes arrive in minor versions; pin `~` and treat
  spec drift as ongoing maintenance. MCP's own auth story has already changed materially this year.
- **Scope grew during design.** This began as "an admin API" and became "an identity provider".
  That was a deliberate, stated trade — it buys the deferred multi-tenant seam — but it is a
  substantially larger programme than the original ask.

### Verification standard

Per house rules, no milestone claims completion without command output proving it. For M4 that means
a real MCP client completing `server/discover` → `tools/list` → `tools/call` against a throwaway
paddock, plus the negative cases the proxy already proves: disallowed model 403, `mutate` route 403,
no key 401, unfenced route 403.

---

## 7. Amendments (2026-09-15, 2026-09-22)

Made while planning, each verified against `main` at `185c5be`:

| § | Was | Now |
|---|---|---|
| 1, 4.6 | "No loopback posture to preserve" | Production binds loopback by default; only dev/generic bind `0.0.0.0` |
| 2 (C6), 4.4 | Reshape `toMcp` to take templates + paddock | Keep `toMcp(fence)`; templates already live in the fence. Re-decided by the operator |
| 4.2 | `session.ts` retired | `session.ts` stays as the RP session; password login leaves the console |
| 4.1, 6 | CIMD in the auth-service milestone | CIMD + consent screen in M4; device grant in M2 |
| 4.3 | — | Keys have no hard delete; M2 defines `DELETE` semantics |

Plans: [`2026-09-15-m1-auth-foundation.md`](../plans/2026-09-15-m1-auth-foundation.md) ·
[`2026-09-15-m3-breed-mcp-tooldefs.md`](../plans/2026-09-15-m3-breed-mcp-tooldefs.md).
M2 and M4 are planned once M1's token contract exists as code.

Made by M2's design, 2026-09-22, each recorded in
[`2026-09-22-m2-admin-api-design.md`](2026-09-22-m2-admin-api-design.md):

| § | Was | Now |
|---|---|---|
| 4.3 | OpenAPI from `z.toJSONSchema()` with `target: 'openapi-3.0'` | OpenAPI 3.1 from the draft-2020-12 output; generated by `gen-openapi.ts`, committed, stale-checked in CI (M2 §2.6, D10; how the schemas are built: M2 §8, A11) |
| 4.6 | Admin-API exposure to be decided in M2 | Decided: the admin API inherits the console's bind, unchanged (M2 §2.5, D9) |
| 6 | M2: device grant for the admin CLI | Interactive only; non-interactive/CI auth explicitly deferred (M2 §2.4, D5) |
| 6 | M2: admin API over the provisioning surface | Users, invites and licence not exposed in v1 (M2 §2.7, D11) |

Plan: [`2026-09-22-m2-admin-api.md`](../plans/2026-09-22-m2-admin-api.md).
