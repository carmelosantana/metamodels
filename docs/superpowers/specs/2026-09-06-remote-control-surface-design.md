# Remote control surface — unified OIDC auth, admin API, per-paddock MCP

**Status:** design settled, not planned. **Date:** 2026-09-06.
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

Three premises the work started from turned out to be false, each verified this session:

| Premise | Reality |
|---|---|
| Control plane binds `127.0.0.1`, so an admin API would weaken that posture | Both compose files publish `"${CONTROL_PLANE_PORT:-3000}:3000"` with **no host-IP prefix** — that is `0.0.0.0` (`docker-compose.yml:56`, `docker-compose.deploy.yml:50`). There is no loopback posture to preserve, only one to *establish*. Docker also documents that published ports bypass `ufw`. |
| Adding an MCP SDK would break the zero-dependency norm for MCP's sake | The norm breaks for **OAuth**, not MCP. Under spec `2026-07-28` a minimal MCP server is three JSON-RPC methods over one POST route. |
| `toMcp?(fence)` is the right shape, merely unwired | It is structurally incapable of serving ComfyUI (§4.4). |

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
| C6 | `toMcp` fate | **Reshape** to `(ctx) => McpToolDef[]` | Current signature cannot serve ComfyUI |
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

### 4.2 Console becomes a relying party

`auth/session.ts` (the hand-rolled signed cookie) is retired in favour of the OP session.
`auth/password.ts` and `auth/login-throttle.ts` move behind the OP's interaction flow, not deleted.
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
- **OpenAPI is generated, not hand-written.** Verified: `zod@3.25.76` resolves for all four packages,
  and the permanently-available `zod/v4` subpath exports `z.toJSONSchema()` producing valid
  draft-2020-12 *and* `target: 'openapi-3.0'` output. **Zero new dependencies.** Every
  `@asteasolutions/zod-to-openapi` 8.x/9.x requires `zod@^4.0.0`, which `3.25.76` does not satisfy.

### 4.4 Breed contract and config publisher

`toMcp` is reshaped:

```ts
toMcp?(ctx: { fence: C; templates: WorkflowTemplate[]; paddock: PaddockRef }): McpToolDef[]
```

The current signature is not merely untyped, it is **insufficient**. `ResolvedPaddock.fence` is
`{ constraintJson, rateLimit, quota }` (`apps/data-plane/src/config/types.ts`), and
`workflow_template` is a separate table (`packages/schema/src/schema.ts:82`) that never reaches the
data plane. `toMcp(fence)` can serve Ollama — tools derive from `allowedModels` and `allowedRoutes`
inside `constraintJson` — but cannot serve ComfyUI, whose useful tools are one-per-WorkflowTemplate
with typed inputs. The hook would have failed on the second breed the moment anyone implemented it.

Folding templates into `constraintJson` was rejected: it conflates policy with content. A Fence
means *what is allowed*, not *what exists*.

`config-publisher` therefore carries templates into `ResolvedPaddock`.

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

The `0.0.0.0` publish is now a decision to make deliberately rather than an inherited default. It is
in scope for M2 and must be settled there, not left implicit.

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
| **M1** | Auth foundation | `auth` service, oidc-provider, Drizzle adapter, `findAccount`, interaction views; console cut over to RP; `session.ts` retired |
| **M2** | Admin API | `/api/admin/*` Route Handlers, scopes ∩ role, audit `changed_by`, OpenAPI from Zod, bind/exposure decision |
| **M3** | Breed & config prep | `toMcp` reshape, templates into `ResolvedPaddock`, both breeds implement |
| **M4** | MCP endpoint | `/p/<slug>/mcp`, Streamable HTTP, RFC 9728 on both resource servers |

M1 is load-bearing — M2 and M4 both authenticate against it. M3 is independent of M1/M2 and may run
in parallel if capacity allows.

### Risks

- **M1 touches the one path that must never break.** Console login has no fallback once `session.ts`
  is retired. Consider proving the OP alongside the existing login before cutting over.
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
