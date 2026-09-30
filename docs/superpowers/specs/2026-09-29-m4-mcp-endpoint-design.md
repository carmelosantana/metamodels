# M4 — per-paddock MCP endpoint over full OAuth 2.1

**Status:** design settled 2026-09-29. **Parent:** [`2026-09-06-remote-control-surface-design.md`](2026-09-06-remote-control-surface-design.md) (C4, C5, §4.5, §6 M4).
**Builds on:** M1 (the OP, `apps/auth`), M2 (admin API, device grant, refresh-token policy, `changed_by`), M3 (`toMcp(fence): McpToolDef[]`), verified against `main` at `4d36af2`.
**Wayfinding map:** Kanboard #3871 (project 142).

---

## 1. What M4 delivers

A real MCP client, local (Claude Code, VS Code) or cloud (Claude.ai, ChatGPT), connects to
`<DATA_PLANE_URL>/p/<slug>/mcp`. It discovers the OP through RFC 9728 metadata and identifies itself
with a Client ID Metadata Document (CIMD). A signed-in `member` or `admin` approves it on a consent
screen. The client then calls `server/discover` → `tools/list` → `tools/call`. Every call is
rate-limited, quota-checked, `guard()`-enforced and metered exactly as the streaming proxy is.

## 2. The parent spec's contradiction, settled

The parent contradicts itself about MCP auth:

- C5 and §3 say "full OAuth 2.1", and "one credential system … tokens from the OP".
- §2.4 says the MCP endpoint "inherits key auth, rate limit, quota, `guard()` and metering unchanged".

**Ruling (operator, 2026-09-29): full OAuth.** `/p/<slug>/mcp` accepts **only** OP-issued access
tokens. It never accepts an `mm_live_` key, and the proxy never accepts an OAuth token. §2.4 is
re-read as a statement about *enforcement*: rate limit, quota, `guard()` and metering are inherited
unchanged. Key auth is not inherited. D1 is what makes the inheritance hold without key auth.

## 3. Decisions

| # | Crux | Decision | By |
|---|---|---|---|
| D0 | MCP credential | **OAuth only** (§2) | operator |
| D1 | Metering identity for an OAuth caller | **Consent mints a key**: an `api_key` row of `kind='oauth'`, bound to the grant and scoped to one paddock | operator |
| D2 | Resource URI | **One resource per paddock**: `<DATA_PLANE_URL>/p/<slug>/mcp`, resolved dynamically | ruling |
| D3 | Who may approve | **`member` and `admin`**, via the existing `resource.write` capability | operator |
| D4a | CIMD admission | **Open**: any well-formed https CIMD client. The consent screen is the gate | operator |
| D4b | Exposure | **Defaults unchanged.** Add `DATA_PLANE_URL`, plus a DEPLOY.md recipe for remote connectors | operator |
| D5 | CSP on the consent flow | **Per-response `form-action`** rewrite for CIMD redirect origins, on the `switchAccountMiddleware` pattern | ruling |
| D6 | Shared verifier | **`@metamodels/schema/access-token`**, the offline RFC 9068 verifier core, extracted from `admin-token.ts` | ruling |
| D7 | Where the consent-time mint runs | **Control plane.** The OP calls an internal route with an OP-signed assertion | operator |
| D8 | `tools/call` dispatch | **The breed plans a synthetic request** that runs the proxy's own gate pipeline | ruling |
| D9 | Protocol era | **Dual-era**: modern `2026-07-28` plus legacy `2025-11-25`/`2025-06-18`, both stateless (§4.1) | operator |

Each ruling is recorded with its cost-if-wrong in §9.

### 3.1 D1 — consent mints a key

Everything that limits or bills a caller hangs off `api_key`:
- `usage_rollup.key_id` and `job.key_id` are `NOT NULL`;
- the rate limiter keys on the key;
- `key_paddock` scopes a key to paddocks;
- the Keys page is where an operator sees and revokes consumers.

Keys are org-level and have no owner. So an OAuth grant gets its own key:

- **Schema.** `api_key` gains:
  - `kind text not null default 'live'`, with a CHECK that it is `'live'` or `'oauth'`;
  - `grant_id text`, `oauth_client_id text` and `user_id uuid` (FK `user.id` ON DELETE CASCADE), all nullable;
  - a CHECK that all three are set iff `kind='oauth'`.

  A unique partial index on `(user_id, oauth_client_id, paddock)` is not expressible, because the
  paddock lives in `key_paddock`. Idempotency is therefore enforced in the service, under the
  per-org lock (see *Idempotent*).
- **Unpresentable.** An oauth key's `hash` is `hashApiKey(<32 random bytes>)`. The plaintext is
  discarded at once and never returned, logged or shown, so there is nothing to present.
- **Kind separation.** `resolveKeyByHash` returns only `kind='live'`. The new `resolveKeyById`
  returns only `kind='oauth'`. An `mm_live_` key cannot open MCP, and an OAuth key cannot open the
  proxy, even in theory.
- **Naming.** `"<client_name> (MCP) · <user email>"`, truncated to 120 characters. The
  Keys page shows kind and client, and can revoke. It never offers to reveal a secret.
- **Idempotent.** A second consent by the same user, for the same client and paddock, rebinds the
  existing active oauth key's `grant_id` to the new grant (audited as `key.rebind`); it does not
  mint another. Otherwise the service creates a new key (audited as `key.create`, detail
  `{kind:'oauth', client_id}`).
- **The token names the key.** The OP's `extraTokenClaims` adds `mm_kid` to MCP-resource access
  tokens. It looks up the active oauth key whose `grant_id = token.grantId` **and** whose `key_paddock` is the token's paddock (one grant can back several paddocks, `interactions.ts:70-74`). If there is none, the
  key has been revoked and the grant is dead, so it refuses to issue (`invalid_grant`). A revoked key
  therefore stops working at the data plane on the next config invalidation, and cannot be
  refreshed back to life.
- **Revocation.**
  - Keys-page revoke works as today, and is authoritative.
  - OP-side grant or refresh revocation (RFC 7009) stops new tokens from being minted. The key row
    stays until an operator revokes it.
  - `setUserStatus(…,'deactivated')`, and `changeUserRole` to `viewer`, revoke that user's oauth
    keys in the same transaction, with one audit row each. This keeps D3 true after the fact.
- **Usage.** Rollups, quota and the dashboard are unchanged, and oauth keys appear in them by name.

### 3.2 D2 — one resource per paddock

MCP clients MUST send `resource=<canonical server URI>`, and that URI is the endpoint they
connect to. So the resource indicator is necessarily per paddock: `<DATA_PLANE_URL>/p/<slug>/mcp`.

- **Config.** New required setting `DATA_PLANE_URL`: the public origin of the data plane, with no
  trailing slash. It is configuration and never derived (parent §4.6). `schema/oidc.ts` gains
  `mcpResource(dataPlaneUrl, slug)` and `parseMcpResource(dataPlaneUrl, uri) → slug | null`. Both
  services use them, so the string exists in exactly one place.
- **Dynamic resolution.** `getResourceServerInfo` stops being a pure static-map lookup. For a URI
  that `parseMcpResource` accepts, it reads `paddock` by slug (auth already reads `user`; this is
  read-only). If the paddock is `active`, it returns
  `{ scope: 'mcp', accessTokenFormat: 'jwt', accessTokenTTL: 15*60, jwt: { sign: { alg: 'RS256' } } }`.
  Otherwise it answers `invalid_target`.
- **Client gate.**
  - MCP resources are open **only to CIMD clients**: `client.clientIdMetadataDocument === true`.
  - The admin-API resource stays CLI-only. `resourcesByClient` and `verifyAdminToken`'s
    `client_id` check are unchanged.
  - A CIMD client asking for the admin API gets `invalid_target`.
  - First-party static clients get no MCP resource. YAGNI; nothing needs one.
- **Lifetimes.** Access tokens last 15 minutes, which is shorter than the admin API's hour, because
  the data plane verifies offline and a revoked key is otherwise caught only by the config check.
  Refresh tokens reuse M2's policy unchanged: rotation, a 30-day idle window and the absolute cap in
  `refreshTokenTtl`.

### 3.3 D3 — who may approve

The mint runs through `keys-service` with an `Actor` loaded from the DB, via the existing
`loadActiveActor`. `requireCapability(actor, 'resource.write')` is the gate, so `viewer` is refused.
The user must also be in the paddock's org. The consent screen checks both *before* rendering the
Approve button (a read-only preflight, §3.5). A viewer therefore sees a plain refusal, not a button
that fails. On refusal the interaction finishes with `access_denied` and a human-readable
`error_description`.

### 3.4 D4 — CIMD admission and exposure

- **Enable CIMD.** Set `features.clientIdMetadataDocument: { enabled: true, ack: 'draft-02' }`.
  `oidc-provider` is already pinned `~9.12.2`. Draft bumps arrive in minors, so the pin stays `~`,
  and a test asserts the ack value, so an upgrade that moves the draft fails loudly.
- **Admission is open.** `allowFetch` and `allowClient` accept any client that passes the library's
  own `isValidClientIdUrl`, which covers https only, no fragment, no userinfo and no dot-segments.
  - `allowClient` additionally requires `token_endpoint_auth_method: 'none'`, `grant_types` within
    `authorization_code` and `refresh_token`, and every `redirect_uri` to be https or loopback http.
  - PKCE S256 is already mandatory for every client.
- **SSRF.** The library's CIMD fetch installs an undici dispatcher that destroys connections to
  special-use IPv4 and IPv6 addresses (`lib/helpers/fetch_request.js`). If undici is unavailable,
  the library silently falls back to no guard. M4 therefore adds a **boot assertion and a test**: a
  CIMD `client_id` on `https://127.0.0.1…` and one on a name resolving to RFC 1918 space must both
  fail to fetch. If the guard is absent, the OP refuses to start with CIMD enabled.
- **Issuer scheme.** CIMD is enabled only when `OIDC_ISSUER` is https, or loopback http for local
  clients and e2e. Any other issuer boots with CIMD off and logs why.
- **Exposure.** `AUTH_BIND` stays loopback and `DATA_PLANE_BIND` stays `0.0.0.0`. DEPLOY.md gains a
  "Remote MCP connectors" section covering:
  - a TLS reverse proxy or tunnel in front of `auth` and the data plane;
  - setting `OIDC_ISSUER` and `DATA_PLANE_URL` to their https origins;
  - the fact that the console need not be public.

  `scripts/new-stack.sh` writes a `DATA_PLANE_URL` default of `http://127.0.0.1:${DATA_PLANE_PORT}`, the loopback spelling `docker-compose.portainer.yml` uses (the resource is compared exactly, so one spelling per stack).

### 3.5 D7 — the mint runs in the control plane

The consent screen stays in `auth`, beside login. `keys-service` stays the only writer of keys, so
org scoping and audit are inherited. *(Amended 2026-09-29: `keys-service` publishes no invalidation; its callers publish (`(app)/keys/actions.ts`, `admin-route.ts`). The internal route therefore calls `publishConfigInvalidation` itself, as those callers do. The new `mintOauthKey` takes the per-org lock, as §3.1's idempotency requires.)*

- **Route.** `POST /api/internal/v1/oauth-keys` is a control-plane Route Handler. It is called by
  the OP over the compose network at `CONTROL_PLANE_INTERNAL_URL`, which defaults to
  `http://control-plane:3000`.
- **Credential.** The request carries an **OP-signed assertion**: a JWT signed with the OP's current
  signing key, carrying:
  - `typ: 'mm-consent+jwt'`, `iss = OIDC_ISSUER`, `aud = <CONSOLE_URL>/api/internal`;
  - `exp ≤ 60 s` and a unique `jti`;
  - `sub` (user id), `client_id`, `client_name`, `resource` and `grant_id`.

  The control plane verifies it with the shared verifier (D6) against the JWKS it already trusts,
  with `typ` and `aud` fixed. It rejects a replayed `jti` using a short-TTL Redis `SET NX`. If Redis
  cannot answer, the route fails closed: a 503 problem with `Retry-After: 5`, never a mint. The
  client's `commandTimeout` settles every claim within about 2 s, whether Redis refuses, is
  black-holed or accepts and stalls, well inside the OP's 5 s call timeout. ioredis's defaults took
  ~10.5 s on a refused port and forever on a stalled socket *(amended 2026-09-30, F3)*.
- **The route re-derives everything.**
  - It loads the actor from `sub` (`loadActiveActor`, so an inactive user or an unknown role is
    refused).
  - It parses the slug from `resource`.
  - It then calls `mintOauthKey(db, actor, { clientId, clientName, paddockSlug, grantId })`.
  - Nothing in the assertion is trusted beyond "the OP says this user approved this client for this
    resource under this grant".
- **Audit identity.** `Credential` gains a third form, `` `consent:${clientId}:${grantId}` ``. It
  stays a closed grammar, and `writeAudit` is unchanged.
- **Bearer only.** The route follows the M2 posture: it refuses a request that also carries a
  session cookie. Its answers:
  - 401 for a bad assertion;
  - 403 for a missing capability;
  - 404 for an unknown or inactive paddock;
  - 200 `{ key_id }`.
- **Preflight.** `GET /api/internal/v1/oauth-keys/preflight`, with the same assertion shape, answers
  `{ allowed, reason }` for the consent screen (§3.3). It is read-only.
- **Not a public API.** The route is absent from the OpenAPI document and from `/api/admin/*`. It
  exists wherever the console listener does, which by default is loopback. Only an OP-signed
  assertion opens it.
- **The OP's side.** On Approve, the OP calls the route. It then saves the grant with the `mcp` scope
  for that resource, and finishes the interaction. If the call fails, the interaction ends with
  `server_error` and no grant is saved, so no grant ever exists without a key.

### 3.6 D5 — CSP on the consent flow

`authCsp(redirectOrigins)` is computed once, at provider construction, from the console origin.
After Approve, oidc-provider redirects the browser to the CIMD client's `redirect_uri`, whose origin
is not in that list. Browsers apply `form-action` to redirects that follow a form submission, so the
static header would block the hand-back.

The fix is a `cimdCspMiddleware`, on the pattern of PR #20's `switchAccountMiddleware`. After the
response is built, on interaction routes whose client is a CIMD client, it rewrites the response's
CSP to append **that client's validated `redirect_uri` origin** to `form-action`. Every other
directive, and every other response, keeps the static policy. A test asserts both the widened header
on a CIMD consent response and the unchanged header everywhere else. If looking up the interaction
or its client fails, the page keeps the static policy and the failure is logged; it is never turned
into a 500 *(amended 2026-09-30, F4)*.

### 3.7 D6 — one offline verifier

`admin-token.ts` holds a carefully reasoned RFC 9068 verifier:
- `expiredBeforeVerifying`;
- the `kid`-miss / cooldown split between 401 and 503;
- `TokenError` versus `KeySetUnavailableError`;
- `requiredClaims: ['exp']` and the `typ` pin.

The data plane needs exactly that logic, with a different audience. It moves to a new subpath,
`@metamodels/schema/access-token`:

```ts
export function createAccessTokenVerifier(opts: {
  issuer: string; jwksUrl: string; typ: string
}): (jwt: string, audience: string) => Promise<Record<string, unknown>>
export { TokenError, KeySetUnavailableError }
```

- `admin-token.ts` becomes a thin caller. The audience is the admin resource, and it keeps its
  `client_id === CLI_CLIENT_ID` and scope handling, so its behaviour and tests are unchanged.
- The data plane calls the verifier with `audience = mcpResource(DATA_PLANE_URL, slug)`.
- The consent route (D7) calls it with `typ: 'mm-consent+jwt'`.
- `jose` becomes a dependency of `@metamodels/schema`. It is already in the tree at `^6.2.12`, with
  the same author as `oidc-provider`. **`/powerup:supply-chain` runs before the `package.json`
  change** (house rule), even though no new package enters the lockfile.
- The data plane reaches the JWKS over the compose network (`OIDC_INTERNAL_URL`), re-homed exactly
  as `onOrigin` does for the console.

### 3.8 D8 — how `tools/call` runs

M3 gave each breed `toMcp(fence)` but no way to *execute* a tool. M4 adds one optional hook to
`Breed<C>`:

```ts
/** Translate one tools/call into the request the proxy would have received. Pure; no I/O. */
mcpCall?(name: string, args: unknown, fence: C):
  | { ok: true; request: { method: 'GET' | 'POST'; path: string; body?: unknown } }
  | { ok: false; error: string }   // → CallToolResult { isError: true }
/** Shape the proxy's result as MCP content; the fence can narrow it (Ollama list_models). */
mcpResult?(name: string, result: { status: number; body: unknown }, fence: C): McpCallToolResult
```

- **Dispatch.** The MCP handler first has the breed plan the call; a call it cannot plan is
  `isError` (`invalid arguments: …`) and spends no rate-limit or quota budget *(amended 2026-09-30, F6)*.
  It builds a `RequestCtx` from the planned request, then runs the **same pipeline** as `ALL /p/:slug/*`:
  - rate limit, then quota;
  - `guard(ctx, fence)`, then `handle` or `proxyToUpstream`, then `meter`.

  No tool can reach anything the fence does not allow. A `mutate` route is refused by `guard()`
  even if a breed planned one, and a unit test asserts that each breed's `mcpCall` never plans one.
- **Ollama.**
  - `chat` plans `POST /api/chat`, `generate` plans `POST /api/generate`, and `embed` plans
    `POST /api/embed`.
  - `chat` and `generate` are planned with `stream: false`, because MCP tool results are one
    JSON-RPC response. `embed` carries no `stream` field: Ollama's `/api/embed` does not stream.
    SSE streaming of a single `tools/call` is out of scope.
  - Only what each inputSchema declares is forwarded. `chat` rebuilds every message as
    `{ role, content }` (both strings; `role` is `system`, `user` or `assistant`) and refuses a message
    carrying any other field; `embed`'s `input` must be strings. Both refusals are `invalid arguments`
    *(amended 2026-09-30, F7)*.
  - `mcpResult` returns the assistant text, or the embedding array, as `text` content, plus
    `structuredContent`.
- **ComfyUI.**
  - `run_<tpl>` plans the same request that the proxy's template route receives, returning
    `{ job_id }`.
  - `get_job_result` plans `GET /p/:slug/result/:jobId`. It reuses that route's own-job check,
    which is `job.keyId === resolvedKey.keyId`, so an MCP client sees only its own grant's jobs.
    This is the parent's Stateful Tools pattern: an opaque handle, re-authorized on every call.
  - The REST result route returns image *references* only (`comfyui/result.ts`). The MCP result
    fetches each output via `/view` server-side and returns `image` content (base64), capped at
    8 MiB per result; an oversized output returns `isError` naming the cap.
  - Every MCP `tools/call`, `get_job_result` included, is rate-limited; the REST result route is not,
    and stays unchanged.
- **Ollama `list_models`.** M3's Ollama `toMcp` also emits `list_models` (`ollama/mcp.ts`); it plans
  the fence-filtered model listing, like the other tools.
- **Errors.**
  - A gate refusal (403 fence, 429 rate or quota) becomes `CallToolResult { isError: true }`,
    carrying the same short reason string the proxy returns. The JSON-RPC transport still succeeds.
  - An upstream credential error is not a per-call `isError`: it answers HTTP 503 at the paddock
    gate, before any method is dispatched (§4.2 step 4), because `tools/list` cannot carry `isError`.
  - An unknown tool name gets a JSON-RPC `-32602` error.

## 4. The endpoint

### 4.1 Transport (amended 2026-09-29: D9 dual-era, exact wire rules)

`POST /p/:slug/mcp`, Streamable HTTP, one JSON-RPC message per POST, answered `application/json`
(no method streams, so SSE is never used). Stateless in both eras: no `Mcp-Session-Id` is minted,
and `Mcp-Session-Id` / `Last-Event-ID` are ignored. `GET` and `DELETE` answer 405. The route is
registered **before** the `ALL /p/:slug/*` catch-all, and a test proves the proxy never sees `/mcp`.
`/p/:slug/mcp/` and every path beneath it answer 404 for every method and are never proxied: the
resource is compared exactly, so no token names them *(amended 2026-09-30, F1)*. Every `/p/*` request
body, MCP included, is limited to 32 MiB; a larger one is 413 `{ error: 'request body too large' }`.
A declared `Content-Length` over the limit is refused before authentication, the body unread; any
other body is counted as the handler reads it, after authentication, so nothing is buffered for an
anonymous caller *(amended 2026-09-30, F2)*. No SDK: the method set is small.

**Common to both eras.** An `Origin` header, when present, must be the `DATA_PLANE_URL` origin, else
403 (DNS-rebinding rule). A notification answers 202 with no body. Batches are refused (`-32600`).

**Modern (`2026-07-28`).** `MCP-Protocol-Version`, `Mcp-Method`, and (for `tools/call`) `Mcp-Name` are
required and must match the body — the header version equals
`params._meta["io.modelcontextprotocol/protocolVersion"]`, and `=?base64?…?=` values are decoded
before comparing — else 400 with `-32020` HeaderMismatch. An unsupported version answers 400 with
`-32022` and `data: {supported, requested}`. An unknown method answers HTTP 404 with `-32601`.

| Method | Result |
|---|---|
| `server/discover` | `{resultType:'complete', supportedVersions, capabilities:{tools:{}}, _meta:{'io.modelcontextprotocol/serverInfo':{name:'metamodels', version}}, cacheScope:'private'}` |
| `tools/list` | `breed.toMcp(fence)`, already sorted and valid (M3); `cacheScope: 'private'`; no pagination |
| `tools/call` | §3.8 |

**Legacy (`2025-11-25`, `2025-06-18`).** `initialize` answers `{protocolVersion, capabilities:{tools:{listChanged:false}}, serverInfo}`
(echoing a supported legacy version, else the newest); `notifications/initialized` answers 202;
`ping` answers `{}` (legacy only — the modern revision removed it, so modern `ping` gets 404 `-32601`); `tools/list` and `tools/call` reuse the same handlers with legacy result shapes.
Era is chosen per request: `initialize`, or a legacy `MCP-Protocol-Version` without modern `_meta`,
is legacy; everything else is validated as modern.

Every modern result carries `resultType` and `_meta['io.modelcontextprotocol/serverInfo']`; `server/discover` and `tools/list` also carry the required caching hints `ttlMs: 0` and `cacheScope: 'private'` (the schema's `CacheableResult` makes `ttlMs` required; `0` because a fence edit must show on the next list).

OAuth (§4.2), the gate pipeline and metering are identical in both eras. `serverInfo.version` is the
version the stack already exposes, or `'0.0.0'` if it exposes none.

### 4.2 Authentication at the data plane

On every request:

1. Take the bearer token. If there is none, answer 401 with
   `WWW-Authenticate: Bearer resource_metadata="<DATA_PLANE_URL>/.well-known/oauth-protected-resource/p/<slug>/mcp", scope="mcp"`
   (MCP 2026-07-28 authorization, "Scope Selection Strategy": the `scope` a client asks for first) *(amended 2026-09-30, F5)*.
2. Verify it with the shared verifier (D6):
   - `iss`, RS256, `typ at+jwt` and required `exp`;
   - `aud` must equal `mcpResource(DATA_PLANE_URL, slug)`. A token for another paddock, or for the
     admin API, gets 401. This is no token passthrough, by construction.
3. `resolveKeyById(mm_kid)`, which is `kind='oauth'` only, active, and not expired. Its
   `paddockSlugs` must include `slug`. The `client_id` claim must equal the key's `oauth_client_id`.
4. Continue with the paddock gates already in `resolveScope`: unknown or inactive paddock gives 404;
   an `upstreamAuthError` gives 503.

Every refused token gets **one fixed 401 body and the same challenge (scheme, `resource_metadata`, `scope`)**, as
`unauthorized.ts` already does for keys. That avoids an enumeration oracle. A
`KeySetUnavailableError` answers 503 with `Retry-After: 30`, mirroring the admin API.

### 4.3 The consent screen (auth service)

It is a server-rendered view in `views.ts`, under the auth service's static CSP (it has no nonce; `views.ts:26-46`) and with no remote assets. Client
logos are not loaded, because `img-src` stays `'self'`. It shows:

- the client's `client_name` and its **`client_id` host**, set in bold. The host is the identity
  claim a user can check; the name is self-asserted;
- the redirect host;
- the paddock name and slug;
- the signed-in user's email. *(No switch-account link exists to reuse; `switchAccountMiddleware` handles a different step. The plan decides whether the screen offers one.)*

Approve and Deny post back to the OP. Deny ends the interaction with `access_denied`. If the
preflight (§3.5) returns `allowed: false`, the screen shows the reason and only a Close button.

## 5. RFC 9728 on both resource servers

- **Data plane.** `GET /.well-known/oauth-protected-resource/p/:slug/mcp` returns
  `{ resource, authorization_servers: [OIDC_ISSUER], scopes_supported: ['mcp'], bearer_methods_supported: ['header'] }`.
  An unknown or inactive slug gets 404. It is served **without** auth. There is no key to rate-limit
  on, and the document is static per slug from the cached config.
- **Admin API.** `GET /.well-known/oauth-protected-resource/api/admin` on the control plane returns
  `{ resource: adminApiResource(CONSOLE_URL), authorization_servers: [OIDC_ISSUER], scopes_supported: CAPABILITIES, … }`.
  The admin API's 401 challenge gains `resource_metadata=`.
- Both documents are built from the same `@metamodels/schema/oidc.ts` helpers as the OP's resource
  map, so the issuer, resource strings and scopes cannot drift.

## 6. Non-goals

- No `mm_live_` on MCP, and no OAuth on the proxy (§2).
- No SSE, no server-initiated requests, no `resources/*` or `prompts/*`, no tool-list pagination.
- No DCR. It is deprecated; CIMD is the path.
- No CIMD allowlist. D4a chose open. An allowlist is additive later, in `allowClient`.
- No console UI for OP grants. The Keys page is the control surface (D1).
- No public exposure by default (D4b).
- `mutate` routes stay permanently unexposable (parent §5).

## 7. Verification standard

Per the parent's §6, against a throwaway stack (`-p mm-verify`, non-default ports, throwaway slugs,
cleaned up afterwards):

- **The real client.** An MCP client completes CIMD discovery → consent → token → `server/discover`
  → `tools/list` → `tools/call` on an Ollama paddock and on a ComfyUI paddock (run, then
  `get_job_result`).
  - The client's CIMD document is served by the e2e harness on loopback https, or by an
    SSRF-test-exempt fixture wired only into the e2e OP config, never into production defaults.
  - The run shows the metered `usage_rollup` row under the oauth key.
- **Negative cases**, each shown by command output:

  | Case | Expected |
  |---|---|
  | no token | 401 + `resource_metadata` |
  | token for another paddock | 401 |
  | admin-API token | 401 |
  | `mm_live_` key on `/mcp` | 401 |
  | oauth token on the proxy | 401 |
  | disallowed model via `tools/call` | `isError` (fence 403) |
  | `mutate` route | never listed, never planned |
  | viewer consent | `access_denied` |
  | revoked key | 401 at the data plane, `invalid_grant` on refresh |
  | loopback / RFC 1918 CIMD `client_id` | fetch refused |
  | replayed consent assertion | 401 |
- The existing proxy e2e suite stays green, unchanged.

## 8. Risks

- **CIMD is draft-02 and experimental upstream.** The `~` pin plus the ack-assertion test turn a
  draft bump into a failing test, not a silent behaviour change.
- **An internal route on the console listener.** Its only credential is an OP signature with a
  dedicated `typ` and `aud`, a 60-second life and a `jti` replay guard. A console exposed publicly
  exposes the route's existence, not its use.
- **Offline verification lag.** A revoked key is refused once the data plane's config cache
  invalidates, which is immediate over pubsub. The 15-minute access-token TTL bounds the damage if
  pubsub is down. Nothing else changes.

## 9. Rulings (cost if wrong)

| Ruling | Why | Cost if wrong |
|---|---|---|
| D2 per-paddock resource, dynamic lookup | MCP clients send the endpoint URL as `resource`; there is no other choice | Low: a single data-plane resource would add scopes and weaken audience isolation |
| D2 15-minute MCP access tokens | Offline verification; revocation hinges on the config cache | Low: one constant |
| D5 per-response `form-action` rewrite | The static CSP blocks the CIMD redirect | Low: the pattern already exists (PR #20) |
| D6 verifier in `@metamodels/schema/access-token` | One reasoned verifier, not two; the data plane has no `jose` | Medium: a shared-package refactor touching M2's admin path, guarded by M2's existing tests |
| D8 breed `mcpCall`/`mcpResult` through the proxy pipeline | Enforcement stays in `guard()`; annotations are untrusted | Medium: breed-contract growth; both breeds implement it |
| Demote-to-viewer revokes oauth keys | Keeps D3 true after the fact | Low: an operator re-consents after re-promotion |
| `mm_kid` via `extraTokenClaims`, refused when the key is dead | A revoked key must not refresh back to life | Low |
| Refresh tokens without `offline_access` | oidc-provider issues refresh tokens only for `offline_access`, which it drops unless `prompt=consent`; real MCP clients send neither | Low: `issueRefreshToken` returns true for a CIMD client allowed `refresh_token` whose grant is bound to an MCP resource; every other client keeps the default |
| Replay guard falls back to memory without `REDIS_URL` | Matches `publishConfigInvalidation`, a no-op without Redis; every compose stack has Redis | Low: per-process only in single-process dev; DEPLOY.md says so |
| 32 MiB body limit on every `/p/*` request, MCP included (F2) | A worst-case incompressible 2048² RGBA PNG is 21.34 MiB as base64; MCP's `run_<tpl>` is the same request as `/submit` (D8) | Low: one constant; a larger input image is refused 413 and the limit is raised |
| `scope="mcp"` on every MCP 401, no `insufficient_scope` 403 (F5) | MCP 2026-07-28 SHOULDs `scope` in the 401 challenge; every MCP token carries exactly `mcp`, and a token without it stays a collapsed 401 | Low: a second scope would add the 403 arm; the admin API's challenge is not governed by the MCP spec and is unchanged |
| Replay guard fails closed with 503 when Redis is unreachable, every claim bounded by a 2 s `commandTimeout` (F3) | An unclaimable `jti` must not be honoured; the fault is the service's, not the assertion's; the OP gives up after 5 s, so the answer has to arrive sooner | Low: an approval during a Redis outage fails with `server_error`, and the user retries |

## 10. Amendments from planning (2026-09-29)

Found while writing the plan, each checked against `main` at `4d36af2`. The plan follows the code.
Rows marked **F1**–**F8** were added on 2026-09-30 by the M4 follow-ups plan
([`2026-09-30-m4-followups.md`](../plans/2026-09-30-m4-followups.md)), checked against `main` at `ae4ac8a` (0.6.0).

| § | Was | Now |
|---|---|---|
| 3.1 | `mm_kid` looked up by grant | By grant **and** paddock — one grant can back several paddocks |
| 3.5 | Mint inherits the invalidation | `keys-service` publishes no invalidation; the internal route publishes it itself |
| 3.5 | Mint inherits the org lock | `mintOauthKey` takes the per-org lock itself (§3.1); only the invalidation is left to the caller |
| 3.5 | Preflight names a grant | No grant exists at preflight (`interactions.ts:141-153`); preflight carries no `grant_id` |
| 3.8 | Images returned base64 by the result route | The route returns references; MCP fetches `/view` under an 8 MiB cap |
| 3.8 | Ollama: chat, generate, embed | Plus M3's `list_models` |
| 3.8 | — | MCP rate-limits every `tools/call`; the REST result route stays unlimited |
| 3.8 | 503 upstream credential is a per-call `isError` | HTTP 503 at the paddock gate before dispatch (§4.2 step 4); `tools/list` cannot carry `isError`. 403 fence and 429 rate or quota stay `isError` |
| 3.8 | Ollama tools all planned with `stream: false` | `chat` and `generate` only; `embed` has no `stream` field (`/api/embed` does not stream) |
| 3.8 | Unknown tool gets `-32602` | Answered before `mcpCall` runs |
| 3.8 | `mcpResult(name, result)` | `mcpResult(name, result, fence)` — list_models filters the listing by the fence (REST /api/tags unchanged) |
| 4.1 | Modern only; 400 for a bad version header | D9 dual-era; exact modern wire rules (`-32020`, `-32022`, 404 `-32601`, 202, Origin 403) |
| 4.3 | Nonce CSP; existing switch-account link | Static auth CSP; no such link exists |
| 3.4 | `AUTH_BIND`/`DATA_PLANE_BIND` stay | They exist only in `docker-compose.portainer.yml` |
| 5 | Admin 401 gains `resource_metadata` | Four M2 tests assert the bare challenge and are updated with it |
| 7 | RFC 1918 CIMD refusal in e2e | Proven by unit test; the e2e records the refusals it can reach. The e2e runs both a modern and a legacy sequence |
| 3.4 | A CIMD `client_id` on `https://127.0.0.1…` and one on a name resolving to RFC 1918 space must both fail to fetch | The loopback literal is proven by a live fetch; the RFC 1918 name case by the `isSpecialUseIP` table (no offline DNS to fake a resolution) |
| 3.4 | `allowClient` refuses grants beyond code/refresh | oidc-provider 9.12.2 drops server-unsupported grants from a CIMD document before `allowClient` runs; the refusal is proven with `device_code`, a grant this OP enables |
| 4.1 (F1) | `/p/:slug/mcp/` fell through to the proxy catch-all | 404 for every method on `/mcp/` and beneath it; never proxied |
| 4.1 (F2) | No request body limit on MCP or the proxy | 32 MiB on every `/p/*` body; 413 before authentication for a declared `Content-Length`, as it is read (after authentication) otherwise |
| 4.2 (F5) | Challenge `Bearer resource_metadata="…"` | `Bearer resource_metadata="…", scope="mcp"` on every MCP 401 |
| 3.8 (F6) | Rate limit and quota spent before `mcpCall` validated the arguments | Plan first; an unplannable call is `isError` and spends nothing; every call that plans is still limited |
| 3.8 (F7) | `chat` forwarded whole message objects | Each message rebuilt as `{ role, content }`, anything else refused; `embed` input must be strings |
| 3.5 (F3) | Redis unreachable: the claim rejected after ~10.5 s (never, on a stalled socket) and the route answered a raw 500 | ioredis settles every claim within ~2 s (`commandTimeout: 2000`, plus `maxRetriesPerRequest: 1` and `connectTimeout: 2000`), covering the offline queue and a stalled socket; the route answers 503 + `Retry-After: 5` |
| 3.6 (F4) | An `Interaction.find` failure escaped the CSP middleware as a 500 | Both lookups guarded; the static policy stays and the failure is logged |
