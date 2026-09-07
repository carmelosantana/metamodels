# Admin API patterns — primary-source research

**Date:** 2026-09-06
**Question:** How should MetaModels expose a remote operator/admin surface (flocks, paddocks, fences, keys) without reusing consumer `mm_live_` keys and without silently discarding the "control plane is not internet-reachable" posture?

Every claim below is traced to official documentation or source. Where a claim could not be verified from a primary source it is marked **UNVERIFIED**.

---

## Bottom line

1. **The separate-listener pattern is real but not universal.** Kong is the one system in this survey that genuinely binds its admin API to a different port *and* a different interface by default: `admin_listen` defaults to `127.0.0.1:8001` / `127.0.0.1:8444` while `proxy_listen` defaults to `0.0.0.0:8000` / `0.0.0.0:8443` ([Kong configuration reference](https://developer.konghq.com/gateway/configuration/)). LiteLLM, Grafana, and Portainer all serve admin and data on one listener. So "admin on its own port" is a *defensible* choice, not an industry default.

2. **Kong's own OpenAPI document carries the warning verbatim** — this is the archetype quote to cite in an ADR: "This API is designed for internal use and provides full control over Kong, so care should be taken when setting up Kong environments to avoid undue public exposure of this API." ([`kong-admin-api.yml`, Kong/kong master](https://raw.githubusercontent.com/Kong/kong/master/kong-admin-api.yml)). The config reference adds: "It is highly recommended to avoid exposing the Admin API to public interfaces, by using values such as `0.0.0.0:8001`."

3. **Next.js structurally cannot give MetaModels a second listener.** `next start` takes exactly one `-p/--port` and one `-H/--hostname` (default `0.0.0.0`) ([next CLI](https://nextjs.org/docs/app/api-reference/cli/next)). There is no per-route port binding. So the Kong-style "separate admin port" is only achievable by (a) putting the admin API on the Hono data plane's process as a distinct path/port, or (b) running a second Next process, or (c) accepting a path-scoped admin surface on the control plane's single port and defending it at the network edge.

4. **Server Actions are definitively not a public API contract.** Next.js documents that action IDs are "encrypted, non-deterministic IDs… periodically recalculated between builds", "created during compilation and… cached for a maximum of 14 days", and "regenerated when a new build is initiated or when the build cache is invalidated" ([Data security](https://nextjs.org/docs/app/guides/data-security)). A third party cannot pin an action ID. Route Handlers are the documented API surface: "Route Handlers are public HTTP endpoints. Any client can access them." ([Backend for Frontend](https://nextjs.org/docs/app/guides/backend-for-frontend)).

5. **But server actions *are already* reachable by POST today.** "By default, when a Server Action is created and exported, it is reachable via a direct POST request, not just through your application's UI… you should still treat Server Actions as reachable via direct POST requests and verify authentication and authorization inside each one." ([Data security](https://nextjs.org/docs/app/guides/data-security)). MetaModels' existing `requireCapability` calls inside the service layer are load-bearing, not belt-and-braces.

6. **The repo's service layer is the right seam and needs no restructuring.** `requireCapability(actor, cap)` takes an `Actor = {id, orgId, email, role}` (`apps/control-plane/src/auth/authorize.ts`). An admin token is therefore just *a second way to mint an Actor* — org scoping, capability gating, transactions, and audit writes all come along unchanged. This is the single highest-leverage finding for the design.

7. **Do not put auth only in middleware/proxy.** CVE-2025-29927 (CVSS 9.1, critical) let an attacker set `x-middleware-subrequest` to skip middleware entirely: "It is possible to bypass authorization checks within a Next.js application, if the authorization check occurs in middleware" ([GHSA-f82v-jwr5-mffw](https://github.com/advisories/GHSA-f82v-jwr5-mffw)). Next's own docs now say Proxy "should not be your only line of defense" and "Always verify authentication and authorization inside each Server Function rather than relying on Proxy alone."

8. **The "control plane binds 127.0.0.1" premise does not hold as shipped.** Both compose files publish `"${CONTROL_PLANE_PORT:-3000}:3000"` with **no host-IP prefix**, which binds `0.0.0.0`; no `127.0.0.1:` appears anywhere in either file. Docker further documents that this defeats host firewalls: "When you publish a container's ports using Docker, traffic to and from that container gets diverted before it goes through the ufw firewall settings" ([Docker: packet filtering and firewalls](https://docs.docker.com/engine/network/packet-filtering-firewalls/)). So the decision is not "should we weaken the loopback posture" — the artifacts do not currently implement one. See the repo-grounding section.

9. **Zod v4's native `z.toJSONSchema()` is already available here with zero new dependencies, and the alternatives are all worse.** The lockfile resolves `zod@3.25.76` for all four packages, and 3.25.x ships Zod 4 at the permanently-available `zod/v4` subpath ([Versioning](https://zod.dev/v4/versioning)). Verified empirically against the installed package — valid draft-2020-12 output, exit 0. By contrast every `@asteasolutions/zod-to-openapi` 8.x/9.x declares `peerDependencies: {"zod": "^4.0.0"}`, which `3.25.76` does not satisfy (forcing a real major bump), and `next-openapi-gen` pulls nine transitive dependencies including a Babel parser stack. `target: "openapi-3.0"` is built in.

10. **A static, greppable credential prefix is a defensible design, not cargo cult** — see §B6. MetaModels already has `mm_live_` for consumer keys; a distinct operator prefix (e.g. `mm_admin_`) keeps the two credential classes separable by grep, by log scrubber, and by the auth code path. **Add a CRC32 checksum tail** — Grafana does it in ~15 lines for 8 characters ([`tokengen.go`](https://github.com/grafana/grafana/blob/main/pkg/components/satokengen/tokengen.go)), and GitHub tells secret-scanning partners to do the same. It buys offline validation with no database hit.

11. **The token must carry its own authorization, not impersonate its creator.** This is the sharpest good/bad split in the survey. Grafana service accounts are independent principals with their own role; Vault tokens carry their own policy set; LiteLLM keys carry `allowed_routes` + `models`. Portainer's API key resolves straight to `{ID, Username, Role}` of its owner, with no narrowing and no expiry — a permanent full-power impersonation. **MetaModels drifts into Portainer's design by default** if an operator token simply rehydrates the minting user's `Actor`. Cap grants at (requested) ∩ (minting user's role), and require an expiry.

12. **Consider HMAC-with-a-server-side-pepper instead of a bare digest.** Vault stores modern tokens as `"h" + hex(HMAC-SHA256(salt, tokenID))` with a persisted salt ([`token_store.go`](https://github.com/hashicorp/vault/blob/main/vault/token_store.go)). A database dump alone then cannot verify a guessed token, and — unlike a salted KDF — the digest stays deterministic and indexable, preserving the O(1) lookup the hot path needs. Strictly better than plain SHA-256 at near-zero cost.

13. **SHA-256 over a high-entropy random token is correct, and the authority is NIST — not OWASP.** NIST SP 800-63B-4 §3.1.2.2 sets an explicit **112-bit** threshold: look-up secrets below it "SHALL be stored in a salted and hashed form using a suitable password hashing scheme"; at or above it, "an approved hashing function" suffices. MetaModels' `randomBytes(24)` is **192 bits**, so the existing `createHash('sha256')` in `packages/schema/src/keys.ts` is compliant as written. **The OWASP passage usually cited for this does not exist** — the Password Storage Cheat Sheet never mentions API keys or tokens, and its anti-SHA-256 line is about passwords only. Do not cite it; it argues the wrong way.

14. **Audit needs a request-side record and a before-image, neither of which exists today.** Kong splits the trail two ways — `/audit/requests` (who called what) and `/audit/objects` (which entity changed), correlated by `request_id`, with TTL and optional RSA signing ([Kong audit logs](https://developer.konghq.com/gateway/audit-logs/)). LiteLLM's `LiteLLM_AuditLog` adds two fields MetaModels lacks: `changed_by_api_key` (which credential acted, by hash — essential once more than one credential can mutate) and `before_value` (the pre-change snapshot). Since the service layer is already transactional, writing the audit row in the same transaction buys Vault's fail-closed guarantee for free.

15. **CSRF: a bearer-token route handler is a different threat model from a cookie session, but OWASP does not hand you a one-line exemption.** The CSRF cheat sheet argues via preflight — "All modern browsers designate requests with custom headers as 'to be preflighted'" — and never explicitly states bearer APIs need no CSRF defense ([OWASP CSRF Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)). The safe posture: the admin route handler accepts **only** `Authorization: Bearer`, **never** falls back to the session cookie, and enables no permissive CORS. Portainer enforces exactly this, rejecting requests that carry both — "API key and auth header are not allowed at the same time".

---

## A. Per-system comparison

| System | Admin API on separate listener? | Default bind | Admin credential | Scopes / roles on the token | Audit | OpenAPI |
| --- | --- | --- | --- | --- | --- | --- |
| **Kong Gateway** | **Yes** — `8001`/`8444` vs proxy `8000`/`8443` | **`127.0.0.1`** (proxy binds `0.0.0.0`) | None in OSS by default (loopback *is* the control); Enterprise RBAC uses a `Kong-Admin-Token` header | Enterprise RBAC: roles → endpoint permissions `read/create/update/delete`, scoped by Workspace | **Best in survey** — `/audit/requests` + `/audit/objects` correlated by `request_id`, TTL, optional RSA signing. Off by default | Yes — OpenAPI 3.1 `kong-admin-api.yml`, but thin and partly stubbed |
| **LiteLLM proxy** | **No** — one FastAPI app, one uvicorn, default `:4000`. No `admin_port` exists | `0.0.0.0:4000` | `LITELLM_MASTER_KEY` (`sk-…`, prefix is convention only, unenforced) or a `key_type: management` virtual key, via `Authorization: Bearer` | **Yes, per key** — `key_type` → `allowed_routes` presets (`llm_api` / `management` / `read_only`), plus `models`, `permissions`, budgets, TPM/RPM | `LiteLLM_AuditLog` table (`before_value`, `updated_values`, `changed_by_api_key`) — **Enterprise-licensed**, off unless `store_audit_logs: true` | Yes — FastAPI-generated at `/openapi.json`, **Swagger UI at `/` by default** |
| **Traefik** | Optionally — `api.insecure` puts it on the `traefik` entrypoint `:8080`; secure mode routes it through normal entrypoints | `api.insecure` defaults to **`false`** | **None built in** — you attach a middleware (basicAuth / forwardAuth / JWT / OIDC) | None; authorization is router rules + middleware | N/A — the API performs no mutations | **No** — zero `*openapi*`/`*swagger*` files in the repo |
| **Grafana** | **No** — single `http_port`, default `3000`, shared with the UI and query path | `0.0.0.0:3000` | Service-account token `glsa_…`, `Authorization: Bearer`; API keys fully removed (auto-migrated by Jan 31 2025) | Service account is **its own principal** with an org role (Viewer/Editor/Admin/None) + Enterprise RBAC `{action, scope}` pairs | Enterprise feature (not examined in depth) | Yes — **go-swagger generated** from annotated Go; v2 canonical (`api-merged.json`), v3 machine-converted |
| **Vault** | **No** — single `:8200` | `0.0.0.0:8200` (config-dependent) | Service token `hvs.…` / batch token `hvb.…` (pre-1.10: `s.` / `b.`) | **Best-in-class** — HCL `path` + `capabilities` policies, deny-by-default, `deny` beats `sudo`, most-specific-match, parameter constraints | Audit devices HMAC-SHA256 every string value; **fail-closed** — if no device can log, Vault refuses the request | (not in scope — auth model only) |
| **Portainer** | **No** — API under `/api` on the same `:9443` as the UI | `0.0.0.0:9443` | Access token `ptr_` + base64(32 random bytes), `X-API-Key` header | **None** — the token is pure impersonation; it inherits the creating user's role wholesale | UNVERIFIED (not examined) | Yes — swaggo annotations, `securitydefinitions.apikey ApiKeyAuth` on `X-API-KEY` |

**Reading the table.** Only Kong separates admin from data at the listener level. Everyone else relies on credential scoping and network placement — which means "one port, two credential classes, strict per-route authorization" is the *majority* pattern and is entirely defensible for MetaModels. The differentiator between good and bad implementations is not the port; it is whether the token carries its own independent authorization (Grafana, Vault, LiteLLM: yes) or merely impersonates its creator (Portainer: no).

*(Details and citations for each system follow.)*

---

## A-detail. Kong Gateway

**1. Separate listener and default bind.** The configuration reference documents:

- `admin_listen` default: `["127.0.0.1:8001 reuseport backlog=16384", "127.0.0.1:8444 http2 ssl reuseport backlog=16384"]`
- `proxy_listen` default: `["0.0.0.0:8000 reuseport backlog=16384", "0.0.0.0:8443 http2 ssl reuseport backlog=16384"]`

and states verbatim: "The Admin interface is the API allowing you to configure and manage Kong. Access to this interface should be *restricted* to Kong administrators *only*… It is highly recommended to avoid exposing the Admin API to public interfaces, by using values such as `0.0.0.0:8001`" ([configuration reference](https://developer.konghq.com/gateway/configuration/)).

The [Secure the Admin API](https://developer.konghq.com/gateway/secure-the-admin-api/) guide adds: "By default, Kong Gateway only accepts requests from the local interface (`127.0.0.0:8001`)" (the `127.0.0.0` is a typo in Kong's docs; the config reference gives `127.0.0.1`), and advises keeping "the listening footprint to a minimum to avoid exposing your Admin API to third-parties," using host-based firewalls (iptables), the API-loopback trick (proxying Kong's own Admin API through Kong so plugins apply), key-auth, or Enterprise RBAC.

The same warning is embedded in Kong's published OpenAPI document itself, which is the most quotable form of it:

> "`8001` is the default port on which the Admin API listens. `8444` is the default port for HTTPS traffic to the Admin API. This API is designed for internal use and provides full control over Kong, so care should be taken when setting up Kong environments to avoid undue public exposure of this API."
> — [`kong-admin-api.yml`](https://raw.githubusercontent.com/Kong/kong/master/kong-admin-api.yml)

**2. Credential.** Kong OSS ships the Admin API with **no authentication at all** — the localhost bind *is* the control. Authentication is added either by proxying the Admin API through Kong and applying the key-auth plugin, or, in Enterprise, by RBAC with a `Kong-Admin-Token` header carrying the RBAC user's `user_token`; without it the API returns 401 ([Enable RBAC with the Admin API](https://developer.konghq.com/how-to/enable-rbac-with-admin-api/), [RBAC](https://docs.konghq.com/gateway/latest/production/access-control/enable-rbac/)). Note the shape of the lesson for MetaModels: Kong treats "bound to loopback" and "authenticated" as *alternative* controls, and the ecosystem widely regards the unauthenticated-but-exposed combination as the classic Kong misconfiguration.

**3. Scopes/roles.** Enterprise RBAC composes roles out of endpoint permissions (workspace + endpoint + actions from `read`/`create`/`update`/`delete`), managed at `/rbac/roles` and `/workspaces/.../rbac/roles`. Roles are Workspace-scoped: "if there are two Workspaces, Payments and Deliveries, an admin created in Payments doesn't have access to any endpoints in Deliveries" ([Workspaces](https://developer.konghq.com/gateway/entities/workspace/), [Configure an RBAC user with custom permissions](https://developer.konghq.com/how-to/configure-rbac-user-in-kong-gateway/)). **Workspace ≈ MetaModels' org.** The org-scoped-token model MetaModels needs is exactly Kong's workspace-scoped role model.

**4. Audit.** Kong audit logs cover "HTTP requests handled by the Admin API, as well as database changes," exposed as two Admin API endpoints ([Kong audit logs](https://developer.konghq.com/gateway/audit-logs/)):

- `/audit/requests` — the request-side record: `rbac_user_id`, `rbac_user_name`, workspace UUID, method/path, `request_source`.
- `/audit/objects` — the entity-side record: `payload` of changed objects, plus `request_id` correlating back to the originating request.

Configuration: `audit_log` (`on`; **off by default**), `audit_log_record_ttl` (records past the TTL are automatically purged), and `audit_log_signing_key` — an RSA private key used to sign a lexically sorted representation of each entry "to provide non-repudiation."

The `request_id` correlation between the two tables is the design detail worth stealing: it lets you answer both "what did this operator do" and "what changed on this fence" from the same trail.

**5. OpenAPI.** Kong ships `kong-admin-api.yml` (OpenAPI 3.1, `info.version: 3.4.0`) at the repository root. It is only ~19KB and many paths are empty stubs (`/certificates/{certificates}/snis: []`, `/targets/{targets}: []`), so it is best described as partially generated and incomplete rather than a faithful machine-readable contract.

---

## A-detail. LiteLLM proxy

Verified against `BerriAI/litellm` @ [`168a005`](https://github.com/BerriAI/litellm/commit/168a0055a244acdcf97c330c52e085ab40b1424c), `version = "1.101.0"`.

**1. Separate listener? Definitively no — one FastAPI app, one uvicorn, one port.** A single `app = FastAPI(...)` is built at [`proxy_server.py#L1447`](https://github.com/BerriAI/litellm/blob/168a0055a244acdcf97c330c52e085ab40b1424c/litellm/proxy/proxy_server.py#L1447), and every router — data path and management alike — is mounted on it at [`#L18321-L18374`](https://github.com/BerriAI/litellm/blob/168a0055a244acdcf97c330c52e085ab40b1424c/litellm/proxy/proxy_server.py#L18321-L18374): `app.include_router(router)` (chat/completions) sits beside `key_management_router`, `internal_user_router`, `team_router`, `model_management_router`, and ~40 more. The port is one CLI value defaulting to 4000 ([`proxy_cli.py#L661`](https://github.com/BerriAI/litellm/blob/168a0055a244acdcf97c330c52e085ab40b1424c/litellm/proxy/proxy_cli.py#L661)); the official compose maps only `4000:4000`. There is **no `admin_port` option** — the only genuinely separate listener is an opt-in Prometheus `/metrics` server, which the CLI forces onto a different port.

The [Security Best Practices](https://docs.litellm.ai/docs/proxy/security_best_practices) page offers no separate-port guidance; the nearest advice is to "Run the LiteLLM Gateway on a private network when possible and expose only the routes clients need."

**2. Credential.** `LITELLM_MASTER_KEY` is the proxy-admin credential, set in `general_settings:master_key` or by env var, and the docs state it "🚨 must start with `sk-`". (Documented convention only — **no runtime validation enforcing the prefix was found** in `proxy_server.py`.) Master key and virtual keys arrive identically as `Authorization: Bearer`. The master key is compared with `secrets.compare_digest` and, on match, short-circuits the DB lookup and is handed `PROXY_ADMIN` outright ([`user_api_key_auth.py#L1811-L1830`](https://github.com/BerriAI/litellm/blob/168a0055a244acdcf97c330c52e085ab40b1424c/litellm/proxy/auth/user_api_key_auth.py#L1811-L1830)). Note the hardening in that block: the raw key is swapped for a stable alias so that neither the master key nor its hash propagates into spend logs, Prometheus labels, audit trails, or rate-limit buckets — **a pattern worth copying for any MetaModels root credential.**

Virtual keys are DB-backed rows minted by `/key/generate`: `token = f"sk-{secrets.token_urlsafe(LENGTH_OF_LITELLM_GENERATED_KEY)}"` ([`key_management_endpoints.py#L4011`](https://github.com/BerriAI/litellm/blob/168a0055a244acdcf97c330c52e085ab40b1424c/litellm/proxy/management_endpoints/key_management_endpoints.py#L4011)), default 16 bytes (~128 bits).

**Storage at rest: plain, unsalted SHA-256** ([`_types.py#L250`](https://github.com/BerriAI/litellm/blob/168a0055a244acdcf97c330c52e085ab40b1424c/litellm/proxy/_types.py#L250), duplicated at [`utils.py#L6138`](https://github.com/BerriAI/litellm/blob/168a0055a244acdcf97c330c52e085ab40b1424c/litellm/proxy/utils.py#L6138)):

```python
def hash_token(token: str):
    import hashlib
    hashed_token: Final = hashlib.sha256(token.encode()).hexdigest()
    return hashed_token
```

This is the same choice MetaModels made, on the same reasoning (§B7). A separate scrypt-with-salt `hash_password` exists for **UI passwords only** ([`utils.py#L6149`](https://github.com/BerriAI/litellm/blob/168a0055a244acdcf97c330c52e085ab40b1424c/litellm/proxy/utils.py#L6149)) — the two-function split is exactly the password-vs-token distinction NIST draws.

**3. Roles and scoping.** Seven roles in `LitellmUserRoles` ([`_types.py#L127-L163`](https://github.com/BerriAI/litellm/blob/168a0055a244acdcf97c330c52e085ab40b1424c/litellm/proxy/_types.py#L127-L163)): `proxy_admin` ("has all permissions"), `proxy_admin_viewer` ("view all keys, view all spend"; per [RBAC docs](https://docs.litellm.ai/docs/proxy/access_control), "**Cannot** create keys/delete keys/add new users"), `org_admin`, `internal_user`, `internal_user_viewer` (deprecated), `team`, `customer`.

**The most transferable idea here is per-key route scoping**, which substitutes for the missing admin port. `LiteLLMKeyType` ([`_types.py#L1198-L1206`](https://github.com/BerriAI/litellm/blob/168a0055a244acdcf97c330c52e085ab40b1424c/litellm/proxy/_types.py#L1198-L1206)) has `llm_api`, `management`, `read_only`, `default`, expanded into `allowed_routes` presets ([`key_management_endpoints.py#L636-L650`](https://github.com/BerriAI/litellm/blob/168a0055a244acdcf97c330c52e085ab40b1424c/litellm/proxy/management_endpoints/key_management_endpoints.py#L636-L650)):

```python
if key_type == LiteLLMKeyType.LLM_API:
    data_json["allowed_routes"] = ["llm_api_routes"]
elif key_type == LiteLLMKeyType.MANAGEMENT:
    data_json["allowed_routes"] = ["management_routes"]
elif key_type == LiteLLMKeyType.READ_ONLY:
    data_json["allowed_routes"] = ["info_routes"]
```

`management_routes` (`/user/new`, `/team/new`, `/model/new`, `/model/delete`, …) and `openai_routes` (`/chat/completions`, `/embeddings`, …) are **disjoint sets**. There is an anti-escalation guard: only `llm_api_routes` and `info_routes` are in `_NON_ADMIN_SAFE_ALLOWED_ROUTES_PRESETS`.

This maps directly onto MetaModels' vocabulary: a `key_type` discriminator on the key row, where consumer keys get the proxy route class and operator keys get the admin route class, is a coherent alternative to a wholly separate credential type — though a distinct prefix is still preferable for greppability (§B6).

A `/key/generate` call, verbatim from [Virtual Keys](https://docs.litellm.ai/docs/proxy/virtual_keys):

```bash
curl 'http://0.0.0.0:4000/key/generate' \
--header 'Authorization: Bearer <your-master-key>' \
--header 'Content-Type: application/json' \
--data-raw '{"models": ["gpt-5.6-luna", "gpt-5.6-terra"], "metadata": {"user": "ishaan@berri.ai"}}'
```

Scoping fields on the request model include `models`, `permissions`, `allowed_routes`, `enforced_params`, `team_id`, `user_id`, `max_budget`, `budget_duration`, `tpm_limit`, `rpm_limit`, `duration`, `guardrails`, `auto_rotate`, `rotation_interval`. Who may mint keys is itself policy:

```yaml
litellm_settings:
  key_generation_settings:
    team_key_generation:
      allowed_team_member_roles: ["admin"]
    personal_key_generation:
      allowed_user_roles: ["proxy_admin"]
```

**4. Audit.** [Audit Logs](https://docs.litellm.ai/docs/proxy/multiple_admins) tracks Keys, Teams, Users, Models across Create/Update/Delete/Regenerate. It **requires a LiteLLM Enterprise license**, and is otherwise gated behind `litellm_settings: store_audit_logs: true` (or `LITELLM_STORE_AUDIT_LOGS`). Schema, verbatim from [`schema.prisma#L756-L766`](https://github.com/BerriAI/litellm/blob/168a0055a244acdcf97c330c52e085ab40b1424c/schema.prisma#L756-L766):

```prisma
model LiteLLM_AuditLog {
  id                 String   @id @default(uuid())
  updated_at         DateTime @default(now())
  changed_by         String   @default("")   // user or system that performed the action
  changed_by_api_key String   @default("")   // api key hash that performed the action
  action             String      // create, update, delete
  table_name         String
  object_id          String
  before_value       Json?       // value of the row 
  updated_values     Json?       // value of the row after change
}
```

Two details MetaModels' `audit_log` lacks and should consider: **`changed_by_api_key`** (which credential, by hash, performed the action — essential once more than one credential can mutate) and **`before_value`** (the pre-change snapshot, which turns the trail into something you can actually reconstruct state from). Optional S3 export via `audit_log_callbacks: ["s3_v2"]`.

Distinct from audit logs, **spend logs** are per-request usage keyed by `user_api_key_hash`. Usage telemetry and the admin-action trail are separate tables; do not conflate them.

**5. OpenAPI.** Yes, and **auto-generated by FastAPI** via `fastapi.openapi.utils.get_openapi`, then post-processed by `custom_openapi()` ([`proxy_server.py#L1522-L1601`](https://github.com/BerriAI/litellm/blob/168a0055a244acdcf97c330c52e085ab40b1424c/litellm/proxy/proxy_server.py#L1522-L1601)) to vary the document by viewer role. Defaults ([`utils.py#L7071-L7102`](https://github.com/BerriAI/litellm/blob/168a0055a244acdcf97c330c52e085ab40b1424c/litellm/proxy/utils.py#L7071-L7102)): OpenAPI JSON at **`/openapi.json`**, Swagger UI at **`/`** — the proxy root. Disable with `NO_OPENAPI=true` / `NO_DOCS=true`.

**Security consequence worth stating plainly:** with stock settings, LiteLLM publishes a self-describing schema of its entire admin API at the root of the same port that serves inference traffic.

---

## A-detail. Traefik

Verified against `traefik/traefik` @ [`d48621c`](https://github.com/traefik/traefik/commit/d48621ce0b6fd221b20bdb6c22e652e7498e5db6); versioned quotes from the `v3.4` docs branch.

**1. Exposure guidance.** `api.insecure` "Enable the API in `insecure` mode, which means that the API will be available directly on the entryPoint named `traefik`, on path `/api`… If the entryPoint named `traefik` is not configured, it will be automatically created on port 8080" ([v3.4 operations/api.md](https://doc.traefik.io/traefik/v3.4/operations/api/)).

**Default is `false`** — confirmed both in the [reference table](https://doc.traefik.io/traefik/reference/install-configuration/api-dashboard/) ("Default `false`, Required No") and in the struct field's zero value at [`static_config.go#L184`](https://github.com/traefik/traefik/blob/d48621ce0b6fd221b20bdb6c22e652e7498e5db6/pkg/config/static/static_config.go#L184). Port 8080 is confirmed in source, not just docs ([`static_config.go#L308-L318`](https://github.com/traefik/traefik/blob/d48621ce0b6fd221b20bdb6c22e652e7498e5db6/pkg/config/static/static_config.go#L308-L318)): `ep := &EntryPoint{Address: ":8080"}`.

The warnings, verbatim. From [v3.4 operations/api.md §Security](https://doc.traefik.io/traefik/v3.4/operations/api/):

> Enabling the API in production is not recommended, because it will expose all configuration elements, including sensitive data.
>
> In production, it should be at least secured by authentication and authorizations.
>
> It's recommended to NOT publicly exposing the API's port, keeping it restricted to internal networks (as in the [principle of least privilege](https://en.wikipedia.org/wiki/Principle_of_least_privilege), applied to networks).

And the strongest one, from [v3.4 operations/dashboard.md §Insecure Mode](https://doc.traefik.io/traefik/v3.4/operations/dashboard/):

> This mode is **not** recommended because it does not allow security features. For example, it is not possible to add an authentication middleware with this mode.
>
> It should be used for testing purpose **only**.

That is the sharpest statement in this entire survey: in insecure mode you *cannot* attach auth, so the port is the only control — which is why the default is off. Cite the versioned URL; this section was dropped in master's restructured page.

**2. Read-only? Yes — with one important caveat.** Docs: "All the following endpoints must be accessed with a `GET` HTTP request." Source confirms it: **every** route in [`pkg/api/handler.go`](https://github.com/traefik/traefik/blob/d48621ce0b6fd221b20bdb6c22e652e7498e5db6/pkg/api/handler.go) is `.Methods(http.MethodGet)` — no POST/PUT/PATCH/DELETE in the file.

**The caveat matters.** Traefik does have an HTTP config-write path, but it is a *different feature* — the **REST provider** ([`pkg/provider/rest/rest.go#L40`](https://github.com/traefik/traefik/blob/d48621ce0b6fd221b20bdb6c22e652e7498e5db6/pkg/provider/rest/rest.go#L40)):

```go
router.Methods(http.MethodPut).Path("/api/providers/{provider}").Handler(p)
```

It is off by default, but its `insecure` option lands it on **the same `:8080` entrypoint and the same `/api` prefix** as the insecure API. So "Traefik's API is read-only" is true and yet incomplete: enabling `providers.rest.insecure` yields an unauthenticated `PUT` that rewrites the whole dynamic configuration. It also has no dedicated docs page in the v3 tree, which makes it easy to miss when threat-modelling.

**3. Securing it.** Enable `api` in static config, which creates the special `api@internal` service, then route to it through a normal entrypoint with an auth middleware attached:

```yaml
# static
api: {}
```
```yaml
# dynamic
http:
  routers:
    dashboard:
      rule: Host(`traefik.example.com`) && (PathPrefix(`/api`) || PathPrefix(`/dashboard`))
      service: api@internal
      middlewares: [auth]
  middlewares:
    auth:
      basicAuth:
        users: ["test:$apr1$H6uskkkW$IgXLP6ewTrSuBkTrqE8wj/"]
```

The rule must cover **both** `/api` and `/dashboard` — the UI fetches from `/api`, so a `/dashboard`-only prefix breaks it. Beyond basicAuth, Traefik documents [JWT](https://doc.traefik.io/traefik/secure/secure-api-access-with-jwt/), [OIDC](https://doc.traefik.io/traefik/secure/secure-api-access-with-oidc/), and [WAF](https://doc.traefik.io/traefik/secure/secure-api-access-with-waf/) options. Other defaults: `api` → false, `api.dashboard` → **true** (once the API is on), `api.debug` → false.

**4. Audit.** Not applicable — the API performs no mutations, so there is nothing to audit.

**5. OpenAPI: no.** Traefik Proxy publishes no OpenAPI/Swagger spec for its own API — `find . -iname "*openapi*" -o -iname "*swagger*"` at the pinned commit returns **zero matches**, and neither API docs page mentions one. Beware search-result confusion: OpenAPI appears widely on `doc.traefik.io`, but only as a feature for describing *your* APIs in the commercial products ([Hub](https://doc.traefik.io/traefik-hub/reference/specs/openapi), [Enterprise API Portal](https://doc.traefik.io/traefik-enterprise/operations/apiportal/)).

**The cross-cutting lesson from these two.** Traefik and LiteLLM have *opposite* threat models on the same architectural question. Traefik's admin surface is dangerous because it **reads** — config disclosure — and its docs respond by defaulting the insecure listener off and refusing to run auth-less in production. LiteLLM's is dangerous because it **writes** — mint an unbudgeted key, or register a model pointing at an attacker-controlled base URL — yet it ships that surface on the same port and origin as inference, with a self-describing schema at the root. MetaModels' admin API is squarely in LiteLLM's category (it writes), so it should take Traefik's posture (deny by default, auth mandatory, exposure deliberate).

---

## A-detail. Grafana — service accounts and tokens

**1. The API-key deprecation.** Service accounts arrived in 8.5 and went GA in **9.1**, when deprecation was announced: "API keys are deprecated. Service accounts now replace API keys for authenticating with the HTTP APIs" ([Migrate API keys to service account tokens](https://grafana.com/docs/grafana/latest/administration/service-accounts/migrate-api-keys/)). The sunset timeline, from [grafana/grafana#53567](https://github.com/grafana/grafana/issues/53567) and the [2024-06-12 blog post](https://grafana.com/blog/2024/06/12/grafana-update-service-account-tokens-are-replacing-api-keys/):

> - **By Aug. 31, 2024:** Creation of new API Keys will no longer be possible.
> - **By Nov. 30, 2024:** Developers relying on provisioned API keys via automation should migrate to SATs…
> - **By Jan. 31, 2025:** We will migrate any remaining API Keys to SATs automatically and remove the API key endpoints.

Completed per [What's new, 2025-02-10](https://grafana.com/whats-new/2025-02-10-api-keys-fully-deprecated-and-automatically-migrated-to-service-accounts/): "All existing API keys have been automatically migrated to Service Accounts."

**UNVERIFIED:** the exact release number in which the `/api/auth/keys` endpoints were removed — Grafana published a *date*-based timeline, not a version. The 11.0 breaking-changes page has no API-key entry.

The migration shape is instructive because MetaModels faces the same question: `POST /api/apikeys` → `POST /api/serviceaccount` followed by `POST /api/serviceaccount/<id>/token`. **A token is created under a named principal, not free-floating.**

**2. Format — and a checksum.** Documented only implicitly in prose; the contract lives in [`pkg/components/satokengen/tokengen.go`](https://github.com/grafana/grafana/blob/main/pkg/components/satokengen/tokengen.go):

```go
const GrafanaPrefix = "gl"
func (p *PrefixedKey) key() string { return GrafanaPrefix + p.ServiceID + "_" + p.Secret }
func (p *PrefixedKey) CalculateChecksum() string {
	checksum := crc32.ChecksumIEEE([]byte(p.key()))
	// ... little-endian 4 bytes, hex-encoded
}
func (p *PrefixedKey) String() string { return p.key() + "_" + p.Checksum }
```

Shape: **`gl` + serviceID + `_` + 32-char secret + `_` + 8 hex CRC32**. Service accounts pass `serviceID = "sa"`, giving `glsa_`. `Decode()` rejects any token whose checksum does not recompute. Canonical example from the docs: `glsa_<32-char-secret>_<8-hex-crc32>`.

**This is the cheapest transferable win in the whole survey.** Eight characters buys offline validation and a sharp secret-scanning regex — the same CRC32 idea GitHub documents (§B6), implemented in ~15 lines.

**3. Storage at rest — PBKDF2, not SHA-256.** From [`pkg/util/encoding.go`](https://github.com/grafana/grafana/blob/main/pkg/util/encoding.go):

```go
func EncodePassword(password string, salt string) (string, error) {
	newPasswd, err := pbkdf2.Key(sha256.New, password, []byte(salt), 10000, 50)
	return hex.EncodeToString(newPasswd), nil
}
```

PBKDF2-HMAC-SHA256, 10,000 iterations, 50-byte output. **Two caveats worth knowing before treating this as a model to copy:** the "salt" is the token's own CRC32 checksum — deterministically derived from the token and carried inside it, so it is not secret and adds no entropy beyond the random secret already present; and only the secret segment is hashed, not the full token string. Grafana is doing *more* work than NIST requires for a 32-char random token (§B7) and getting little for it. Do not read Grafana as evidence that a KDF is necessary here.

**4. Roles.** Service accounts take org-level basic roles — "Viewer, Editor, and Admin", plus `None` since 10.2.0 ([Service accounts](https://grafana.com/docs/grafana/latest/administration/service-accounts/)). Enterprise RBAC adds `{action, scope}` pairs — "**Action:** what tasks a user can perform on a resource. **Scope:** where an action can be performed" ([access control](https://grafana.com/docs/grafana/latest/administration/roles-and-permissions/access-control/)):

```json
{ "action": "plugins.app:access", "scope": "plugins:id:grafana-kowalski-app" }
```

That `{action, scope}` pair is the same two-axis shape §B8 recommends — permission level and instance selection kept orthogonal.

Expiry: "By default, service account tokens have no expiration date"; admins can force one with `token_expiration_day_limit`. **MetaModels should not copy the no-expiry default** — §B8's GitHub precedent (fine-grained PATs always expire) is the better one.

**5. Separate port? No.** One listener: "The port to bind to, defaults to `3000`" ([Configure Grafana](https://grafana.com/docs/grafana/latest/setup-grafana/configure-grafana/)). The admin API, service-account API, and dashboard query path all share it, gated only by authn/RBAC.

**6. OpenAPI — generated.** From [`pkg/api/README.md`](https://github.com/grafana/grafana/blob/main/pkg/api/README.md): "Since version 8.4, HTTP API details are specified using OpenAPI v2. Starting from version 9.1, there is also an OpenAPI v3 specification (generated by the v2 one)… The OpenAPI v2 specification is generated automatically from the annotated Go code using go-swagger." Artifacts: `public/api-merged.json` (v2, canonical), `public/openapi3.json` (v3, converted). Notably the required RBAC action and scope are embedded in the swagger annotation itself — the permission contract ships *in* the schema. That is a good pattern for a MetaModels admin spec: state the required capability per operation in the generated document.

---

## A-detail. Vault — auth model only

**1. Token types and prefixes.** From [Tokens — concepts](https://developer.hashicorp.com/vault/docs/concepts/tokens):

> "Tokens have a specific prefix that indicates their type. **As of Vault 1.10, this token format was updated.**… After the prefix, a string of 24 or more randomly-generated characters is appended."

| Token type | ≤ 1.9.x | 1.10+ |
| --- | --- | --- |
| Service tokens | `s.<random>` | `hvs.<random>` |
| Batch tokens | `b.<random>` | `hvb.<random>` |
| Recovery tokens | `r.<random>` | `hvr.<random>` |

Example: `hvs.<random>`. **Vault is the only system here whose docs actually document the prefix contract with a version table** — Grafana's and Portainer's live in source only.

Service vs batch: service tokens "support all features, such as renewal, revocation, creating child tokens… They are correspondingly heavyweight to create and track." Batch tokens "are encrypted blobs that carry enough information for them to be used for Vault actions, but they require no storage on disk to track them… extremely lightweight and scalable, but lack most of the flexibility and features." Batch tokens cannot be renewed, revoked, or have accessors.

**2. Storage at rest.** Vault's published docs are **silent** on token-store hashing — the answer is in [`vault/token_store.go`](https://github.com/hashicorp/vault/blob/main/vault/token_store.go):

```go
// For tokens of older format and belonging to the root namespace, use SHA1 hash for salting.
if ns.ID == namespace.RootNamespaceID && !strings.Contains(id, ".") {
	return s.SaltID(id), nil
}
// For all other tokens, use SHA2-256 HMAC for salting.
return "h" + s.GetHMAC(id), nil
```

So modern tokens are stored as `"h" + hex(HMAC-SHA256(key=per-namespace-salt, msg=tokenID))`, with the salt a persisted per-namespace UUID. Legacy root-namespace tokens fall back to `hex(SHA1(salt || id))`. Storage is additionally encrypted by the barrier.

**This is a concrete, cheap upgrade path for MetaModels.** An HMAC keyed on a server-side secret ("pepper") rather than a bare digest means a database dump alone is insufficient to verify a guessed token — the attacker also needs the application secret. It preserves the deterministic, indexable lookup that a salted KDF would destroy. Vault chose it over both plain SHA-256 and a KDF, for exactly the workload MetaModels has.

**3. Policies — the capability archetype.** From [Policies](https://developer.hashicorp.com/vault/docs/concepts/policies): "Policies are written in HCL or JSON and describe which paths in Vault a user or machine is allowed to access."

```hcl
path "secret/*" {
  capabilities = ["create", "read", "update", "patch", "delete", "list", "recover"]
}
path "secret/super-secret" {
  capabilities = ["deny"]
}
path "secret/restricted" {
  capabilities = ["create"]
  allowed_parameters = { "foo" = [], "bar" = ["zip", "zap"] }
}
```

> "**Because policies are deny by default**, the token would have no other access in Vault."

Capabilities: verb-mapped `create`/`read`/`update`/`patch`/`delete`/`list`, plus non-verb `sudo` ("Allows access to paths that are _root-protected_"), `deny` ("**This always takes precedence regardless of any other defined capabilities, including `sudo`**"), `subscribe`, `recover`.

Three semantics worth stealing outright:

- **Deny-by-default**, with explicit `deny` beating everything including `sudo`.
- **Most-specific-match priority** — earlier wildcards rank lower, longer paths rank higher.
- **The verb/action distinction**, which Vault flags as a known trap: "Capabilities usually map to the HTTP verb, and not the underlying action taken… Generating database credentials _creates_ database credentials, but the HTTP request is a GET which corresponds to a `read` capability." MetaModels has the identical hazard — minting an API key is a `POST` that *creates* a credential, and a "read-only" operator token must not be able to reach it via any read-shaped route.

Also documented: `list` results are **not** filtered by policy — "Do not encode sensitive information in key names." Relevant if paddock slugs are ever enumerable under a narrower grant than the objects themselves.

**4. Lifecycle.** Every non-root token has a TTL; max TTL is resolved at *renewal* time as a min of system max (32 days default), mount-tuned max, and the auth method's suggestion. Periodic tokens reset to a fixed period on each renewal and "never expire" while renewed.

Hierarchy: "When a parent token is revoked, all of its child tokens -- and all of their leases -- are revoked as well. This ensures that a user cannot escape revocation by simply generating a never-ending tree of child tokens." **This is directly applicable:** if a MetaModels operator token can mint consumer `mm_live_` keys, revoking the operator token should cascade to what it created — otherwise revocation is theatre.

**Token accessors** are the sharpest least-privilege primitive here: a separate reference value that permits only look-up, renew, and revoke — never the token ID itself. It lets a management surface list and revoke tokens without ever handling the credential. MetaModels' existing `prefix` column is a weak version of this; a proper accessor would make key administration safe to expose.

**5. Audit.** From [Audit devices](https://developer.hashicorp.com/vault/docs/audit):

> "**By default, Vault only writes a keyed hash (HMAC-SHA256) of most string values to audit logs to protect the confidentiality of potentially sensitive information.**"
>
> "Vault does not hash non-string values, such as integers and booleans. We recommend sending all sensitive data to Vault as string values."

And the fail-closed guarantee, which is the most opinionated stance in this entire survey:

> "Vault sends the audit log entry of every API request and response to all enabled audit devices and guarantees that it saves to at least one of the enabled devices. As a result, if you have audit devices enabled and Vault cannot log information to at least one of the enabled devices, **Vault refuses to service the corresponding API request.**"
>
> "When all enabled audit devices become unavailable, **Vault in effect becomes unavailable as well.**"

HashiCorp's own mitigation is "Enable at least two audit devices." For MetaModels the transferable question is narrower but real: **should an admin mutation that cannot write its audit row be allowed to commit?** Since the service layer is already transactional, writing the audit row in the same transaction gets Vault's guarantee for free on the admin path — without Vault's availability cost, because a DB failure fails the mutation anyway.

---

## A-detail. Portainer — access tokens

Included because MetaModels ships as a Portainer stack, and because it is the **cautionary** row in the table.

**1. Creation and header.** "To generate a token, log into Portainer as your user, navigate to **My account**… then locate the **Access tokens** section… Please copy the access token and keep it in a safe place, as you will not be able to view the token again after creation" ([API access](https://docs.portainer.io/api/access)). Header is `X-API-Key`; confirmed in [`api/portainer.go`](https://github.com/portainer/portainer/blob/develop/api/portainer.go) as `APIKeyHeader = "X-API-KEY"`.

One good detail from [`bouncer.go`](https://github.com/portainer/portainer/blob/develop/api/http/security/bouncer.go): a request carrying **both** an API key and a bearer token is rejected outright — "API key and auth header are not allowed at the same time". That is precisely the ambiguity-elimination §C12 recommends for the MetaModels admin route.

**2. Prefix — `ptr_`, VERIFIED.** Docs are silent; [`api/apikey/service.go`](https://github.com/portainer/portainer/blob/develop/api/apikey/service.go) is explicit:

```go
const portainerAPIKeyPrefix = "ptr_"
randKey := GenerateRandomKey(32)
prefixedAPIKey := portainerAPIKeyPrefix + base64.StdEncoding.EncodeToString(randKey)
apiKey := &portainer.APIKey{ ..., Prefix: prefixedAPIKey[:7], Digest: a.HashRaw(prefixedAPIKey) }
```

`ptr_` + base64(32 random bytes); the first 7 characters are stored in clear for UI display. **No checksum** — unlike Grafana, a Portainer token cannot be validated offline. (Note the same display-prefix idea MetaModels already uses, at 7 chars vs MetaModels' 12.)

**3. Storage — plain unsalted SHA-256**, base64-encoded, over the full prefixed token:

```go
func (a *apiKeyService) HashRaw(rawKey string) string {
	hashDigest := sha256.Sum256([]byte(rawKey))
	return base64.StdEncoding.EncodeToString(hashDigest[:])
}
```

Same choice as MetaModels and LiteLLM, on 256 bits of CSPRNG input — defensible per §B7, and deliberately fast because lookup is by digest on every request.

**4. RBAC — and the anti-pattern.** From [`bouncer.go`](https://github.com/portainer/portainer/blob/develop/api/http/security/bouncer.go), an API key resolves straight to its owner:

```go
tokenData := &portainer.TokenData{ ID: user.ID, Username: user.Username, Role: user.Role }
```

There is **no scoping, no permission narrowing, and no independent role on the token**. Per-token metadata is only `Description`, `Prefix`, `DateCreated`, `LastUsed`. A Portainer API key is a full-power, non-expiring impersonation of its creator — so a key minted by an administrator is an administrator credential forever, until manually deleted. Roles themselves (Environment Administrator, Operator, Helpdesk, Standard User, Read-Only User, …) are **Business Edition only** ([user roles](https://docs.portainer.io/admin/user/roles)).

**This is the design MetaModels must not copy**, and it is the one it would drift into by default if an operator token simply reused the minting user's `Actor` with no further constraint. The cheap guard: cap an operator token's capabilities at the intersection of (requested grants) ∩ (minting user's role), and require an expiry.

**5. Port and OpenAPI.** Same listener as the UI — `https://portainer-url:9443/api/`, with `// @BasePath /api` and an empty `// @host` in [`handler.go`](https://github.com/portainer/portainer/blob/develop/api/http/handler/handler.go). OpenAPI is generated from swaggo annotations, declaring two schemes:

```go
// @securitydefinitions.apikey ApiKeyAuth
// @in header
// @name X-API-KEY
// @securitydefinitions.apikey jwt
// @in header
// @name Authorization
```

Published per-edition at `api-docs.portainer.io`.

---

## B. The credential design question

### 6. Token prefixes and secret scanning

**GitHub.** The canonical rationale is [Behind GitHub's new authentication token formats](https://github.blog/engineering/platform-security/behind-githubs-new-authentication-token-formats/) (GA'd [2021-03-31](https://github.blog/changelog/2021-03-31-authentication-token-format-updates-are-generally-available/)). Prefixes: `ghp_` (classic PAT), `gho_` (OAuth), `ghu_` (user-to-server), `ghs_` (server-to-server), `ghr_` (refresh).

> "token prefixes are a clear way to make tokens identifiable. We are including specific 3 letter prefixes to represent each token, starting with a company signifier, `gh`, and the first letter of the token type."

The documented reasons:

1. **Detectability.** The old 40-char hex tokens were "indistinguishable from other encoded data like SHA hashes." GitHub expected the prefix alone to bring "the false positive rate for secret scanning… down to 0.5%."
2. **The `_` delimiter is deliberate** — verbatim: "An underscore is not a Base64 character which helps ensure that our tokens cannot be accidentally duplicated by randomly generated strings like SHAs. One other neat thing about `_` is it will reliably select the whole token when you double click on it."
3. **Wider character set** — `[a-f0-9]` → `[A-Za-z0-9_]`.
4. **More entropy** — OAuth access tokens went from 160 to 178 bits.

**Yes, there is a checksum:**

> "A checksum virtually eliminates false positives for secret scanning offline. We can check the token input matches the checksum and eliminate fake tokens without having to hit our database. A 32 bit checksum in the last 6 digits of each token strikes the optimal balance… We start the implementation with a CRC32 algorithm… We then encode the result with a Base62 implementation, using leading zeros for padding as needed."

Structure: `gh` + type letter + `_` + Base62 random body + 6-char Base62 CRC32. (No formal ABNF is published, so any exact total length is **UNVERIFIED**.) Note `github_pat_` for fine-grained PATs postdates this post and is documented separately ([Managing your personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)).

**Stripe** ([docs.stripe.com/keys](https://docs.stripe.com/keys)) uses a **two-segment prefix** — type *and* environment: `pk_live_`/`pk_test_` (publishable, safe to expose), `rk_live_`/`rk_test_` (restricted), `sk_live_`/`sk_test_` (secret), `sk_org_` (organization). On secret keys: "API key that has unrestricted permissions on all Stripe APIs. Because you can't limit their permissions, we don't recommend using secret keys for new use cases."

The environment segment is worth stealing independently of scanning: `mm_live_` already implies a `mm_test_` sibling, and an operator credential should follow the same two-segment discipline.

**Slack** ([docs.slack.dev/authentication/tokens](https://docs.slack.dev/authentication/tokens)): `xoxb-` (bot), `xoxp-` (user), `xwfp-` (workflow), `xapp-` (app-level). **`xoxa-` is UNVERIFIED** — it does not appear in Slack's current token-types documentation; historically it denoted legacy workspace tokens. Do not cite it as a current format.

**Is there a published spec/registry?** Yes for GitHub's program, no for a cross-vendor standard.

- [Secret scanning partner program](https://docs.github.com/en/code-security/tutorials/secret-scanning-partner-program) requires a partner to supply (1) "A regular expression which finds the secret type" — with GitHub recommending "a uniquely defined prefix," "high entropy random strings," and "a 32-bit checksum"; (2) "a public, internet accessible HTTP endpoint" to receive match notifications; (3) signature verification using `Github-Public-Key-Identifier` / `Github-Public-Key-Signature` headers under **ECDSA-NIST-P256V1-SHA256**, keys from `https://api.github.com/meta/public_keys/secret_scanning`; and (4) revocation plus user notification, treating "any secrets that GitHub sends you messages about as public and compromised." Enrolment is by email to `secret-scanning@github.com`.
- The public registry is [Supported secret scanning patterns](https://docs.github.com/en/code-security/reference/secret-scanning-patterns) — 600+ provider patterns with columns for partner status, push protection, and validity checks.

Note that GitHub recommends to partners precisely what it built for itself: unique prefix + high entropy + 32-bit checksum. That triple is the closest thing to a spec.

**Cross-vendor standard: essentially none.** [RFC 8959, "The 'secret-token' URI Scheme"](https://www.rfc-editor.org/rfc/rfc8959.html) exists but is **Informational**, standardizes a URI *wrapper* (`secret-token:...`) rather than a vendor prefix convention, mandates that "the entire URI MUST be used, without changes," and has seen essentially no adoption. A cross-vendor prefix standard is **UNVERIFIED — none found.**

**Implication for MetaModels:** a static greppable prefix is well-founded. Recommend `mm_admin_` (or `mm_op_`) as a distinct literal from `mm_live_`, keeping the `_` delimiter, and consider adding a Base62 CRC32 tail so a leaked-token check can be done offline without a database hit.

### 7. Hashing at rest — SHA-256 is correct, but cite NIST, not OWASP

**Correction to a common assumption: the OWASP passage usually cited for this does not exist.** Checked against OWASP's own source repository, not just the rendered site:

- The [Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) contains **zero** occurrences of "API key" or "token". Its only relevant line — "Fast hashing algorithms such as SHA-256 are not suitable for password storage because they allow attackers to perform large numbers of guesses quickly" — is about **passwords**. Quoting it as though it governed API tokens is a misreading, and it would argue the wrong way.
- The Authentication, Session Management, and Secrets Management cheat sheets have no API-token-at-rest guidance either. OWASP ASVS has an open issue, ["Clarify how 'Look-Up Secrets' should be stored"](https://github.com/OWASP/ASVS/issues/1477), acknowledging the gap.

**The real authority is [NIST SP 800-63B-4 §3.1.2.2, Look-Up Secret Verifiers](https://pages.nist.gov/800-63-4/sp800-63b/authenticators/):**

> "Verifiers **SHALL** store look-up secrets in a form that is resistant to offline attacks. All look-up secrets **SHALL** be stored in a hashed form using an approved hashing function."

> "Look-up secrets that are shorter than the minimum security strength specified in the latest revision of [SP800-131A] (i.e., 112 bits as of the date of this publication) **SHALL** be stored in a salted and hashed form using a suitable password hashing scheme."

The previous revision ([SP 800-63B-3 §5.1.2.2](https://pages.nist.gov/800-63-3/sp800-63b.html)) states the positive case directly: "Look-up secrets having at least 112 bits of entropy SHALL be hashed with an approved one-way function."

Contrast §3.1.1.2 for memorized secrets: "Passwords **SHALL** be salted and hashed using a suitable password hashing scheme" — unconditional, no entropy escape hatch.

**So NIST draws an explicit, entropy-conditional line at 112 bits.** Above it, a plain approved one-way hash (SHA-256 qualifies) satisfies the requirement. Below it, a salted iterated KDF is mandatory. **MetaModels' `randomBytes(24)` is 192 bits — it clears the threshold with 80 bits to spare.** The existing `hashApiKey` = SHA-256 hex is compliant as written, and an operator token generated the same way would be too.

**The reasoning**, which the NIST structure makes explicit: slow hashes exist to make guessing expensive when the secret's own entropy is too low to make guessing infeasible. A human-chosen password has perhaps 20–40 bits of real entropy, so a work factor buys back the margin the human failed to supply. A 192-bit CSPRNG token has no such deficit — no dictionary, no pattern, no cross-site reuse — and multiplying an already-infeasible search by a bcrypt work factor changes nothing. Salting is likewise unnecessary: salts defeat rainbow tables and cross-user hash reuse, neither of which applies to values that are globally unique by construction.

The costs of a slow hash here are real and one-directional: you pay the KDF on **every API request** rather than once per login, and a salted KDF's non-deterministic digest destroys the indexable-column lookup — forcing a per-row verification scan or a second lookup key. For a proxy on a request hot path this matters.

**The load-bearing precondition is entropy, not the hash choice.** If a token were ever generated from a timestamp, counter, UUIDv1, or `Math.random()`, the reasoning collapses. Guard `generateApiKey()`'s use of `randomBytes` as a security-critical invariant, ideally with a test.

**Corroborating implementations:**

- **GitLab** ([Authentication development guidelines](https://docs.gitlab.com/development/authentication/)) stores `glpat-` personal/project/group access tokens as a **SHA-256 digest** (deploy and CI job tokens are AES-256-GCM encrypted; OAuth application secrets are SHA-512). Their rule: "Do not add new token types with `insecure: true` storage strategy" and "Do not create ad-hoc token columns or manual hashing."
- **Laravel Sanctum** ([docs](https://laravel.com/docs/12.x/sanctum)): "API tokens are hashed using SHA-256 hashing before being stored in your database, but you may access the plain-text value of the token using the `plainTextToken` property."

For entropy floors, OWASP's [Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html) is still useful: "Session identifiers must have at least `64 bits` of entropy to prevent brute-force session guessing attacks." MetaModels is 3× that.

### 8. Scoped / least-privilege tokens

**GitHub fine-grained PATs** ([permissions reference](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens), [announcement](https://github.blog/security/application-security/introducing-fine-grained-personal-access-tokens-for-github/)) use **four independent axes**:

1. **Resource owner, singular** — "Each token is limited to access resources owned by a single user or organization."
2. **Instance selection** — "Each token can be further limited to only access specific repositories… They can even be targeted at a single repository."
3. **Per-permission level** — "over 50 granular permissions… Each permission can be granted on a 'no access', 'read' or 'read and write' basis." Grouped into Repository / Organization / User domains. Some endpoints need more than one permission; others accept any of a set.
4. **Expiry + org approval** — fine-grained PATs "also expire" (classic PATs "are allowed to live forever"), and "Organization owners can require approval for any fine-grained personal access tokens that can access resources in the organization."

**Stripe restricted keys** ([Restricted API keys](https://docs.stripe.com/keys/restricted-api-keys)): "A RAK starts with `rk_live_` or `rk_test_`. Unlike a secret key that can do anything in your Stripe account, a RAK can do only what you give it permission to do… you select which Stripe resources the key can access and the permissions for each resource: **Read**, **Write**, or **None**."

Two rules stated explicitly and worth copying verbatim:

- **"Write permissions imply read permissions: any key that can write an API resource can also read that resource."**
- **"The default value for all permissions is None."**

Verb mapping: `GET` → read, `POST` → write, `DELETE` → write. Stripe also groups permissions into categories and recommends "one restricted key per service or use case," and states "Stripe recommends always using RAKs instead of unrestricted secret keys, especially when giving a key to an AI agent."

**Borrowable shape.** The union of both models is small and maps cleanly onto MetaModels' existing domain:

```jsonc
{
  "owner":  "org_abc",                 // GitHub axis 1 — one org per token, hard tenant boundary
  "scope":  { "paddocks": ["p_1"] },   // GitHub axis 2 — all | selected instances | none
  "grants": [                          // Stripe axis — per resource, ordered levels
    { "resource": "flocks",   "access": "write" },  // write ⊃ read
    { "resource": "fences",   "access": "read"  }
  ],
  "expires_at": "2026-12-01T00:00:00Z" // GitHub axis 4 — mandatory
}
```

Design rules both vendors document, in priority order:

1. **`none` is the default** for every unlisted resource — omission means deny, never allow.
2. **`write` implies `read`** — a total order `none < read < write`, not independent flags. Add `admin` only if there are genuinely config-mutating operations, as GitHub does.
3. **Instance selection is orthogonal to permission level.** `{resource, access}` alone cannot express "write flock A but not flock B" — that is what the separate scope axis is for. Collapsing the two is the most common modeling mistake in this space.
4. **One owner per token**, so a leaked token cannot cross a tenant boundary.
5. **Mandatory expiry**, plus an approval gate for tokens reaching shared resources.

**How this lands on the existing code.** MetaModels' current `Capability` union (`'read' | 'resource.write' | 'user.manage' | 'license.manage'`) is already a coarse version of the Stripe axis, and `Actor.orgId` is already the GitHub owner axis. The minimum viable operator token is therefore: `orgId` + a capability subset (never exceeding the minting user's own role) + `expires_at`. Per-instance `scope` can be deferred without repainting the model, because it is a genuinely orthogonal axis.

---

## C. Admin API in a Next.js App Router app

### 9. Route Handlers vs Server Actions — the official position

Next.js states plainly that Route Handlers are the public API surface:

> "Route Handlers are public HTTP endpoints. Any client can access them."
> — [Backend for Frontend](https://nextjs.org/docs/app/guides/backend-for-frontend)

The same guide scopes Server Actions narrowly:

> "[Server Actions](/docs/app/guides/server-actions) let you run server-side code from the client. Their primary purpose is to mutate data from your frontend client. Server Actions are queued. Using them for data fetching introduces sequential execution."

and frames the whole capability as an API layer that "is publicly reachable / handles any HTTP request / can return any content type," with the caveat that "Next.js backend capabilities are not a full backend replacement."

Route Handlers support `GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS`; an unsupported method returns 405 automatically, and `OPTIONS` is synthesized with an `Allow` header if not defined ([route.js reference](https://nextjs.org/docs/app/api-reference/file-conventions/route)). Note the routing constraint: "There **cannot** be a `route.js` file at the same route as `page.js`" — so an admin API must live under its own path segment (e.g. `/api/admin/...`), which it would anyway.

**Conclusion for Q9: yes, there is official guidance, and it points at Route Handlers.**

### 10. Are Server Actions a stable HTTP API for third parties? No.

Two documented facts settle this ([Data security](https://nextjs.org/docs/app/guides/data-security)):

> "**Secure action IDs:** Next.js creates encrypted, non-deterministic IDs to allow the client to reference and call the Server Action. These IDs are periodically recalculated between builds for enhanced security."

> "The IDs are created during compilation and are cached for a maximum of 14 days. They will be regenerated when a new build is initiated or when the build cache is invalidated."

An action ID is a build artifact with at most a 14-day life and no stability guarantee across deploys. There is no documented way for a third party to discover or pin one. It is not a public contract.

The corollary matters just as much, and cuts the other way:

> "By default, when a Server Action is created and exported, it is reachable via a direct POST request, not just through your application's UI. This means, even if a Server Action or utility function is not imported elsewhere in your code, it can still be called externally."

> "This security improvement reduces the risk in cases where an authentication layer is missing. However, you should still treat Server Actions as reachable via direct POST requests and verify authentication and authorization inside each one."

Next's audit checklist reinforces it: for `"use server"` files, "Is the user re-authorized inside the action? Does the action check ownership of the resource (authorization, not just authentication)?" And the authentication guide: "Treat Server Actions with the same security considerations as public-facing API endpoints" ([Authentication](https://nextjs.org/docs/app/guides/authentication)).

MetaModels is in good shape here *because* authorization lives in the service layer behind `requireCapability`, not in the page.

### 11. Middleware vs per-route checks, and the CVE

**The advisory.** [GHSA-f82v-jwr5-mffw / CVE-2025-29927](https://github.com/advisories/GHSA-f82v-jwr5-mffw) — **Critical, CVSS 9.1**. Affected: `12.0.0–12.3.4`, `13.0.0–13.5.8`, `14.0.0–14.2.24`, `15.0.0–15.2.2`. Patched in `12.3.5`, `13.5.9`, `14.2.25`, `15.2.3`. The advisory states: "It is possible to bypass authorization checks within a Next.js application, if the authorization check occurs in middleware." The mechanism is the internal `x-middleware-subrequest` header, which an external caller could spoof to make Next skip middleware; the documented workaround is to "prevent external user requests which contain the `x-middleware-subrequest` header from reaching your Next.js application."

Next 16.2.0 (this repo) is far past the patched versions, so the repo is **not vulnerable** — but the architectural lesson is the durable part.

**The current official guidance.** The authentication guide splits checks in two ([Authentication](https://nextjs.org/docs/app/guides/authentication)):

- **Optimistic** — reads session from the cookie, in Proxy, for redirects and UI pre-filtering.
- **Secure** — validated against the database, in the Data Access Layer, for anything sensitive.

> "While Proxy can be useful for initial checks, it should not be your only line of defense in protecting your data. The majority of security checks should be performed as close as possible to your data source."

And, critically for an admin API, the proxy reference warns that matcher coverage is fragile ([proxy.js](https://nextjs.org/docs/app/api-reference/file-conventions/proxy)):

> "[Server Functions] are handled as POST requests to the route where they are used, so a Proxy matcher that excludes a path will also skip Server Function calls on that path. A matcher change or a refactor that moves a Server Function to a different route can silently remove Proxy coverage. Always verify authentication and authorization inside each Server Function rather than relying on Proxy alone."

The BFF guide is blunter still: "Always verify credentials before granting access. Do not rely on proxy alone for authentication and authorization."

**Conclusion for Q11: per-route (in fact per-service-call) checks are mandatory; proxy is at most a cheap pre-filter.**

**Incidental finding.** `middleware.ts` is deprecated as of Next 16. The reference opens with: "**Note**: The `middleware` file convention is deprecated and has been renamed to `proxy`." Rationale given: "the term 'middleware' can often be confused with Express.js middleware… Also, Middleware is highly capable, so it may encourage the usage; however, this feature is recommended to be used as a last resort." Migration: `npx @next/codemod@canary middleware-to-proxy .`. This repo has `apps/control-plane/src/middleware.ts` (a CSP nonce minter) on Next 16.2.0 — still functional, but on a deprecated convention.

### 12. CSRF posture for a bearer-token route handler

**What Next.js gives Server Actions automatically** ([Data security](https://nextjs.org/docs/app/guides/data-security)):

> "Behind the scenes, Server Actions use the `POST` method, and only this HTTP method is allowed to invoke them. This prevents most CSRF vulnerabilities in modern browsers, particularly with SameSite cookies being the default. As an additional protection, Server Actions in Next.js also compare the Origin header to the Host header (or `X-Forwarded-Host`). If these don't match, the request will be aborted."

**Route Handlers get none of that.** There is no built-in origin check on a route handler. Next's guidance is only "Treat Route Handlers with the same security considerations as public-facing API endpoints, and verify if the user is allowed to access the Route Handler," with a worked example returning 401 for no session and 403 for wrong role ([Authentication](https://nextjs.org/docs/app/guides/authentication)).

**The correct posture** (synthesis, grounded in the above plus [OWASP CSRF Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)):

- CSRF is an *ambient-credential* problem. A bearer token in an `Authorization` header is not ambient — a browser never attaches it automatically to a cross-site request. OWASP does not state an explicit bearer-token exemption, but it does establish the mechanism that produces one: "All modern browsers designate requests with custom headers as 'to be preflighted'," and "requests with custom headers are automatically subject to the same-origin policy." Flagging this as **partially verified**: the inference is sound and standard, but OWASP's cheat sheet is written for cookie-authenticated apps and never says the words.
- Therefore the admin route handler must **authenticate only via `Authorization: Bearer`, with no cookie-session fallback on that path.** A handler that accepts *either* re-introduces the CSRF surface, because the cookie half is ambient.
- Do not add permissive CORS. Route Handlers send no `Access-Control-Allow-Origin` unless you write one ([route.js CORS](https://nextjs.org/docs/app/api-reference/file-conventions/route)); leaving it absent means cross-origin JS cannot read responses.
- Keep the cookie-session admin UI and the bearer-token admin API as two separate code paths over one shared service layer.

---

## D. OpenAPI / codegen — and the dependency question

### The installed Zod version

```
apps/control-plane/package.json:22:    "zod": "^3.23.0"
apps/data-plane/package.json:19:    "zod": "^3.23.0"
packages/connectors/package.json:10:  "zod": "^3.23.0"
packages/schema/package.json:18:    "zod": "^3.23.0"
```

All four declare `^3.23.0`; `pnpm-lock.yaml` resolves every one of them to **`zod@3.25.76`**.

### Zod 4 ships inside the 3.25.x line

Zod 4 was deliberately published as a **subpath of `zod@3.25.x`**, not as `zod@4.0.0`, to avoid an ecosystem-wide major-version cascade ([Versioning](https://zod.dev/v4/versioning)):

> "a breaking change to Zod necessarily causes a breaking change for their users. A Zod 3 `ZodType` is not assignable to a Zod 4 `ZodType`."

> "It would trigger a 'version bump avalanche' across the ecosystem and generally create a huge amount of frustration and work."

Consumers install `zod@^3.25.0` and import:

```js
import * as z3 from "zod/v3"
import * as z4 from "zod/v4"
```

The versioned subpaths remain permanently available even now that Zod 4 is the main export — so `zod/v4` is a stable import target, not a migration-window hack.

And `z.toJSONSchema()` is a Zod 4 feature: "Zod 4 introduces first-party JSON Schema conversion via `z.toJSONSchema()`" ([Zod 4 release notes](https://zod.dev/v4)).

### Verified on this machine, against the installed package

The `zod/v4` subpath is present in the installed tree, exported from `package.json`, and `toJSONSchema` is in its type surface:

```
node_modules/.pnpm/zod@3.25.76/node_modules/zod/
  index.cjs  index.d.ts  v3/  v4/  v4-mini/  src/

v4/classic/external.d.cts:8:export { … toJSONSchema, … } from "../core/index.cjs";
v4/core/to-json-schema.d.cts:82:export declare function toJSONSchema(
    schema: schemas.$ZodType, _params?: ToJSONSchemaParams): JSONSchema.BaseSchema;
```

Executed against a Fence-shaped schema on Node v22.23.2:

```js
import { z } from "zod/v4";
const Fence = z.object({
  slug: z.string().min(1),
  allowedModels: z.array(z.string()),
  rateLimitRpm: z.number().int().positive().optional(),
}).meta({ id: "Fence", description: "MetaModels policy object" });
console.log(JSON.stringify(z.toJSONSchema(Fence, { target: "draft-2020-12" }), null, 2));
```

Output:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "id": "Fence",
  "description": "MetaModels policy object",
  "type": "object",
  "properties": {
    "slug": { "type": "string", "minLength": 1 },
    "allowedModels": { "type": "array", "items": { "type": "string" } },
    "rateLimitRpm": { "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 }
  },
  "required": ["slug", "allowedModels"],
  "additionalProperties": false
}
```

Exit 0. **`z.toJSONSchema()` works today, in this repo, with zero new dependencies.**

Documented options ([JSON Schema](https://zod.dev/json-schema)): `target` (`"draft-04" | "draft-07" | "draft-2020-12"` default, **and `"openapi-3.0"`**), `io` (`"input"` vs output), `unrepresentable` (`"throw"` default / `"any"` / custom), and `metadata` (a registry, fed by `.meta()`). The `openapi-3.0` target and `io: "input"` are the two that matter for an admin API: request bodies want input types, responses want output types, and OpenAPI 3.0 needs its own dialect.

### The alternatives, and what they cost

Dependency data read from the npm registry (`registry.npmjs.org`) on 2026-09-06:

| Package | Latest | Runtime deps | Zod peer | Verdict |
| --- | --- | --- | --- | --- |
| **`z.toJSONSchema()` (native)** | in `zod@3.25.76` | **0 new** | n/a — already installed | **Recommended.** JSON Schema + `openapi-3.0` target built in. |
| `zod-to-json-schema` | 3.25.2 | 0 | `^3.25.28 \|\| ^4` | Peer is satisfiable, zero runtime deps — but strictly redundant now. Its own README-era purpose is superseded by the native export. |
| `@asteasolutions/zod-to-openapi` | 9.1.0 | 1 (`openapi3-ts`) | **`^4.0.0`** | **Blocked.** Every 8.x and 9.x release requires `zod@^4.0.0`; `3.25.76` does not satisfy that range. Adopting it forces a real Zod major bump across all four packages. |
| `next-openapi-gen` | 1.8.1 | **9** (`@babel/parser`, `@babel/traverse`, `@babel/types`, `commander`, `cross-spawn`, `fs-extra`, `js-yaml`, `ora`, plus a `typescript` npm-alias to `@typescript/typescript6`) | n/a (peer `typescript`) | **Reject.** A Babel-based source-scanning CLI; heaviest option by far and squarely against the zero-new-dependency norm. |
| `@hono/zod-openapi` | 1.6.3 | 3 (incl. `@asteasolutions/zod-to-openapi@^9`) | `^4.0.0` + `hono >=4.10.0` | Relevant only if the admin API lands on the Hono data plane — but inherits the same `zod@^4` peer block. |

**Recommendation for D:** generate the OpenAPI document from the existing Zod validators using `z.toJSONSchema(..., { target: "openapi-3.0" })` plus a small hand-written OpenAPI envelope (info/servers/security/paths). The envelope is maybe 100 lines of TypeScript; it is generated from the implementation's own schemas, so it cannot drift the way Kong's hand-stubbed YAML has.

---

## Repo grounding (read-only observations)

Facts established by reading the worktree, for whoever writes the design doc:

- **Control plane HTTP surface today** is exactly one route: `apps/control-plane/src/app/api/healthz/route.ts`. Everything else is server actions.
- **Service layer** (`apps/control-plane/src/server/`): `flocks-service.ts`, `paddocks-service.ts`, `fences-service.ts`, `keys-service.ts`, `audit-service.ts`, `auth-service.ts`, `users-service.ts`, `invites-service.ts`, `entitlement-service.ts`, `license-service.ts`, `usage-service.ts`, `templates-service.ts`.
- **Authorization model** (`apps/control-plane/src/auth/authorize.ts`):
  ```ts
  export type Capability = 'read' | 'resource.write' | 'user.manage' | 'license.manage'
  export interface Actor { id: string; orgId: string; email: string; role: Role }
  // roles: admin | member | viewer
  ```
  `requireCapability(actor, cap)` throws `ForbiddenError`. **An admin token only has to produce an `Actor`** — every downstream guarantee (org scoping, capability gate, audit write, `FOR UPDATE` lock) follows for free. This is the cheapest correct integration point.
- **Consumer key generation** (`packages/schema/src/keys.ts`):
  ```ts
  export function hashApiKey(plaintext: string): string {
    return createHash('sha256').update(plaintext).digest('hex')
  }
  export function generateApiKey(): GeneratedKey {
    const raw = randomBytes(24).toString('base64url')   // 192 bits
    const plaintext = `mm_live_${raw}`
    const prefix = plaintext.slice(0, 12)               // 'mm_live_' + 4 chars
    return { plaintext, prefix, hash: hashApiKey(plaintext) }
  }
  ```
  192 bits of CSPRNG entropy, SHA-256 hex at rest, a 12-char display prefix. This is already the right shape (see §B7) and an operator credential should mirror it with a different literal prefix.
- **Data plane credential path** (`apps/data-plane/src/app.ts`): accepts `Authorization: Bearer <key>` or `x-api-key`, then `configStore.resolveKeyByHash(hashApiKey(plaintext))`. A consumer key is resolved to a *paddock*, not to an `Actor` — which is precisely why reusing it for admin calls would be a privilege-escalation bug, not merely bad hygiene: there is no org/role on that path to gate against.
- **Existing audit** covers the object side (actor, action, target, detail, org-scoped, `requireCapability('read')` to list). There is no request-side audit — the gap Kong fills with `/audit/requests`.
- **Next.js version**: `next@16.2.0` (control plane), `hono@^4.6.0` (data plane), React 19.2.0.

### ⚠️ The "control plane binds 127.0.0.1" premise does not hold as shipped

Both compose files publish the control plane without a host-IP restriction:

```yaml
# docker-compose.yml:56  and  docker-compose.deploy.yml:50
ports:
  - "${CONTROL_PLANE_PORT:-3000}:3000"
```

A Docker port mapping with no host IP binds **`0.0.0.0`**, not loopback. Neither compose file contains a `127.0.0.1:` prefix anywhere (verified by grep). And Docker's own documentation warns this is not merely equivalent to an open port — it defeats host firewalls:

> "When you publish a container's ports using Docker, traffic to and from that container gets diverted before it goes through the ufw firewall settings."

> "Docker routes container traffic in the `nat` table, which means that packets are diverted before it reaches the `INPUT` and `OUTPUT` chains that ufw uses."
> — [Docker: Packet filtering and firewalls](https://docs.docker.com/engine/network/packet-filtering-firewalls/)

So on a host with a public interface, the control plane UI and any future `/api/admin` route are reachable from the network **today**, and a `ufw deny` rule will not stop it. The Kong-equivalent of the current posture is `admin_listen = 0.0.0.0:8001`, which is exactly the configuration Kong's docs call out as the thing to avoid.

This matters for the decision framing: adding an authenticated admin API is not "weakening" a loopback posture, because the loopback posture is not currently enforced by the artifacts. The honest options are (a) change the mapping to `127.0.0.1:${CONTROL_PLANE_PORT}:3000` and make remote access deliberate, or (b) treat the control plane as network-reachable and make its authentication carry the full weight. Either is defensible; the current state is the one that is not, because it gets the exposure of (b) with the credential design of (a).

---

## UNVERIFIED / flagged claims

Collected so nothing here is mistaken for a sourced fact:

- **Slack `xoxa-`** — does not appear in Slack's current token-type documentation. Historically legacy workspace tokens; treat as removed, do not cite as a current format.
- **A cross-vendor standard for token prefixes** — none found. [RFC 8959](https://www.rfc-editor.org/rfc/rfc8959.html) is real but Informational, defines a URI *wrapper* rather than a prefix convention, and is essentially unadopted. GitHub's partner program is the de-facto standard.
- **Exact GitHub token length** — the blog post publishes no ABNF, so any precise total-length figure is unverified. Prefix structure and the CRC32 tail *are* verified.
- **The Grafana release that removed `/api/auth/keys`** — Grafana published a date-based timeline (Jan 31 2025), not a version number. The 11.0 breaking-changes page has no API-key entry. Related removal PRs land under milestone 12.1.x.
- **OWASP guidance on hashing high-entropy API tokens** — **does not exist.** Verified against OWASP's own source repository across the Password Storage, Authentication, Session Management, and Secrets Management cheat sheets. Use NIST SP 800-63B §3.1.2.2 instead.
- **OWASP explicitly exempting bearer-token APIs from CSRF** — not stated. The preflight/custom-header mechanism is documented and the inference is standard, but the cheat sheet is written for cookie-authenticated apps. §C12 treats this as partially verified.
- **LiteLLM's `sk-` master-key rule** — documented as a requirement ("🚨 must start with `sk-`") but no runtime validation enforcing it was found in `proxy_server.py`. Treat as convention, not guarantee.
- **Traefik's strongest insecure-mode warning** lives in the versioned `v3.x` docs tree, not current master's restructured page. Cite the versioned URL.
- **Portainer audit logging** — not examined; unknown.
- **Grafana audit logging** — an Enterprise feature; not examined in depth.

---

## What this brief does not decide

Deliberately out of scope, and left for the design doc:

1. **Where the admin API lives** — control-plane route handlers on `:3000`, or the Hono data plane on a separate port. §A shows both are defensible; the Next.js single-listener constraint (bullet 3) and the compose binding reality (bullet 8) are the inputs.
2. **Whether operator tokens get per-instance scoping on day one**, or only `orgId` + capability subset + expiry. §B8 argues the instance axis is orthogonal and can be added later without repainting the model.
3. **Whether to change the compose port mapping to `127.0.0.1:`** — a deployment-posture decision with real UX consequences for Portainer users, not a research question.
