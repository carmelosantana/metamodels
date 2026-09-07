# MCP remote-exposure research (primary sources)

**Date:** 2026-09-06
**Question being researched:** should MetaModels expose itself remotely via an MCP server, an admin HTTP API, or both — and what does the MCP spec actually require of us today?
**Method:** every claim below is traced to the spec, official docs, or source. Where my prior belief disagreed with the source, the source wins and the discrepancy is flagged.

> **Read this first.** The MCP specification changed shape on 2026-07-28 in a way that invalidates most pre-2026 blog-post knowledge about MCP servers — including several premises embedded in the original research questions (`Mcp-Session-Id`, the `initialize` handshake, `Last-Event-ID` resumability, `ping`). Those things no longer exist in the current revision. See §A.

---

## Bottom line

1. **The current spec revision is `2026-07-28`, published 2026-07-28** — not `2025-06-18` or `2025-11-25`. It is the stable release, and all four Tier 1 SDKs (TypeScript, Python, Go, C#) support it. ([spec index](https://modelcontextprotocol.io/specification/latest), [release post](https://blog.modelcontextprotocol.io/posts/2026-07-28/))

2. **MCP is now a stateless request/response protocol.** The `initialize` / `notifications/initialized` handshake was **removed**. Every request carries its own protocol version and client capabilities in `_meta`. ([changelog §Major 2](https://modelcontextprotocol.io/specification/2026-07-28/changelog))

3. **Protocol-level sessions and the `Mcp-Session-Id` header were removed**, as were the standalone `GET` SSE endpoint, `Last-Event-ID` resumability, and `ping`. A conformant 2026-07-28 server answers `GET`/`DELETE` on the MCP endpoint with `405` and ignores `Mcp-Session-Id`. ([changelog §Major 1, 5, 9](https://modelcontextprotocol.io/specification/2026-07-28/changelog); [Streamable HTTP §Earlier revisions](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#backward-compatibility))

4. **This makes the hand-roll dramatically cheaper than it was six months ago.** A minimal spec-conformant remote MCP server is now: one POST endpoint, four methods (`server/discover`, `tools/list`, `tools/call`, and optionally `subscriptions/listen`), no handshake, no session store, no SSE required if every tool answers synchronously. See §D15 for the exact method list and the honest cost estimate.

5. **The dormant `toMcp?(fence: C): unknown[]` hook is exactly what the spec now blesses.** `tools/list` **MUST NOT** vary per-connection, but *"The set **MAY** vary by the authorization presented on the request — for example, returning only the tools the caller's granted scopes permit — since credentials are per-request input, not connection state."* ([Tools §Capabilities](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#capabilities)). Fence → tool list, keyed on the `mm_live_` key, is a conformant design.

6. **OAuth is NOT required.** Authorization is *"**OPTIONAL** for MCP implementations"*, and the base spec explicitly says *"clients and servers **MAY** negotiate their own custom authentication and authorization strategies."* A static `Authorization: Bearer mm_live_...` is out-of-band, not non-conformant. ([Authorization §Protocol Requirements](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization); [Base §Auth](https://modelcontextprotocol.io/specification/2026-07-28/basic/index))

7. **But if you opt into the MCP OAuth framework, it is all-or-nothing and expensive.** Then the MCP server **MUST** implement RFC 9728 Protected Resource Metadata, and the AS **MUST** do OAuth 2.1 + PKCE S256 + RFC 8414 or OIDC Discovery. RFC 7591 Dynamic Client Registration is now **deprecated** in favour of Client ID Metadata Documents. ([Authorization §Overview](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization))

8. **The MCP server is the Resource Server, never required to be the Authorization Server.** *"A protected MCP server acts as an OAuth 2.1 resource server."* The AS *"may be hosted with the resource server or a separate entity."* This is a change of emphasis from 2025-03-26, where the MCP server was effectively expected to be both. ([Authorization §Roles](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#roles))

9. **Token passthrough is explicitly forbidden**: *"MCP servers **MUST NOT** accept any tokens that were not explicitly issued for the MCP server."* and *"The MCP server **MUST NOT** pass through the token it received from the MCP client."* For MetaModels this means: an MCP-surface credential must be minted by MetaModels, and must not be forwarded to Ollama/ComfyUI. ([Security Best Practices §Token Passthrough](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices#token-passthrough); [Authz Security §Access Token Privilege Restriction](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations))

10. **Origin validation is a hard MUST for the data plane.** *"Servers **MUST** validate the `Origin` header on all incoming connections to prevent DNS rebinding attacks"*, responding `403` on a present-and-invalid Origin. Binding to localhost is only a **SHOULD**, and only *"when running locally"* — the public data plane on `:8787` is exempt from that one but not from Origin validation. ([Streamable HTTP §Security & Endpoint](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#security-endpoint))

11. **MCP has no built-in per-tool authorization or scope model.** The `Tool` type in `schema.ts` has no scope, permission, or ACL field; `grep -i scope schema.ts` returns only `cacheScope`. Per-tool authz is done either by filtering `tools/list` per credential (see #5) or by returning `403 + WWW-Authenticate: Bearer error="insufficient_scope", scope="..."` at call time. ([schema.ts](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts); [Authorization §Scope Challenge Handling](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#scope-challenge-handling))

12. **Tool annotations are hints, not a policy mechanism.** *"clients **MUST** consider tool annotations to be untrusted unless they come from trusted servers."* The official post is blunter: *"An untrusted server can lie. A server can claim `readOnlyHint: true` and delete your files anyway."* Do not build fence enforcement on annotations — they are for the client's UX, not our gate. ([Tools §Tool](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#tool); [Tool Annotations post](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/))

13. **Sampling and Roots are deprecated as of 2026-07-28** (earliest removal: first revision on/after 2027-07-28), and server-initiated requests are gone entirely — replaced by Multi Round-Trip Requests. A policy gateway needs none of the three: elicitation, sampling, roots. ([deprecated registry](https://modelcontextprotocol.io/specification/2026-07-28/deprecated); [MRTR](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr))

14. **The spec now actively designs for gateways like MetaModels.** `Mcp-Method` and `Mcp-Name` are **REQUIRED** headers on every Streamable HTTP POST specifically so *"gateways, rate limiters, or WAFs [can] route and meter on those headers instead of parsing JSON bodies."* That is our rate-limit and quota story handed to us for free — and there is a matching **MUST** to reject header/body mismatch with `-32020`. ([Streamable HTTP §Request Metadata](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#request-metadata); [release post](https://blog.modelcontextprotocol.io/posts/2026-07-28/))

15. **Backwards compatibility is the real cost, not the modern protocol.** Legacy (`2025-11-25` and earlier) clients speak `initialize` and are *not* forward-compatible: "Legacy client → Modern server" is listed as **Fails** in the compatibility matrix. Supporting today's installed base of clients means implementing dual-era, which is materially more work than modern-only. ([Versioning §Compatibility Matrix](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning#compatibility-matrix))

16. **A static bearer token works in five of the seven major clients checked**, with no OAuth server on our side: Claude Code (`--header`), VS Code, Cursor, Gemini CLI, and the OpenAI Responses API (`headers` map). Claude.ai/Desktop connectors support it only via an **org-gated beta**; ChatGPT connectors do not document it at all. ([§B9](#b9-what-mcp-clients-actually-support-today))

17. **`mcp-remote` is not needed by any of those clients** — all speak remote HTTP natively. Its README still claims otherwise; that text is stale relative to the clients' own docs, though the project is alive (v0.8.3, 2026-08-31). Do not design around a bridge. ([mcp-remote](https://github.com/geelen/mcp-remote))

18. **`@modelcontextprotocol/sdk` v1.30.0 does NOT implement the current spec** — its `SUPPORTED_PROTOCOL_VERSIONS` tops out at `2025-11-25` and contains zero references to `2026-07-28` or `server/discover`. It also pulls **17 direct / ~93 transitive** packages including Express. The current line is **`@modelcontextprotocol/server@2.0.0` — 2 direct deps, a `zod`-only tree** — which does implement 2026-07-28. ([§D15](#d15-the-official-typescript-sdk-and-the-honest-hand-roll-cost))

19. **The blocking issue for adopting the v2 SDK is `zod`, not size:** it requires `zod ^4.2.0` while this repo pins `zod ^3.23.0` across all four workspace packages. That major upgrade — not dependency count — is the real argument for hand-rolling.

20. **Every mature AI gateway does exactly what `toMcp` implies.** LiteLLM, Portkey, Kong and ContextForge all filter tools per credential and all (except Cloudflare) accept a static API key on `/mcp`. The dominant pattern is a **custom header for the gateway key** (`x-litellm-api-key`, `x-portkey-api-key`), leaving `Authorization` free — and LiteLLM's source carries an explicit guard against forwarding a bare `Authorization` upstream, independently rediscovering the spec's token-passthrough prohibition. ([§D14](#d14-how-existing-ai-gateways-ship-an-mcp-surface))

21. **The natural endpoint already exists in the codebase.** `apps/data-plane/src/app.ts` has `app.all('/p/:slug/*', …)` alongside the rate limiter, quota and config store; `POST /p/<slug>/mcp` is both the idiomatic gateway shape (LiteLLM namespaces the same way) and a small addition. The `toMcp` hook sits at `packages/connectors/src/breed.ts:107`.

---

## A. Transports

### A1. Current revision and defined transports

The specification index states it is *"based on the TypeScript schema in [`schema/2026-07-28/schema.ts`](https://github.com/modelcontextprotocol/specification/blob/main/schema/2026-07-28/schema.ts)"* and links its sub-pages under `/specification/2026-07-28/`. ([spec index](https://modelcontextprotocol.io/specification/latest))

`schema.ts` confirms it directly:

```ts
export const LATEST_PROTOCOL_VERSION = "2026-07-28";
```

([schema.ts L30](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts))

The release was published 2026-07-28, following a release candidate that began 2026-05-21. ([release post](https://blog.modelcontextprotocol.io/posts/2026-07-28/), [RC post](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/))

The transports page defines exactly **two** standard bindings:

> 1. [stdio]: newline-delimited messages over the standard streams of a client-launched subprocess.
> 2. [Streamable HTTP]: each message is an HTTP POST to a single MCP endpoint; replies arrive as a JSON object or a request-scoped SSE stream.

…plus a **custom transports** escape hatch that **MUST** preserve JSON-RPC framing, the message patterns, and the per-request metadata model. ([Transports overview](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports))

> **Discrepancy flagged.** My prior belief was that the current revision was `2025-06-18` with `2025-11-25` as the newest. Both are superseded. Any MetaModels design doc written against `2025-06-18` semantics (sessions, handshake, GET stream) is describing a **Deprecated-era** protocol.

### A2. HTTP+SSE deprecation, and what Streamable HTTP requires

**HTTP+SSE (the old two-endpoint transport) is deprecated.** The Streamable HTTP page carries a Warning:

> **Deprecated**: The HTTP+SSE transport from protocol version 2024-11-05 has been deprecated since protocol version `2025-03-26` and is classified as Deprecated under the feature lifecycle policy ([SEP-2596]). New implementations **SHOULD NOT** adopt it; existing implementations **SHOULD** migrate to Streamable HTTP.

Its earliest removal is *"Three months after SEP-2596 reaches Final."* ([deprecated registry](https://modelcontextprotocol.io/specification/2026-07-28/deprecated))

So: deprecated **as of 2025-03-26**, replaced by **Streamable HTTP**, and now formally on a removal clock.

**What Streamable HTTP requires of a server (2026-07-28):**

| Aspect | Requirement | Cite |
|---|---|---|
| Endpoint | *"The server **MUST** provide a single HTTP endpoint path (hereafter referred to as the **MCP endpoint**) that supports POST."* e.g. `https://example.com/mcp` | [§intro](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http) |
| Methods | POST only. GET and DELETE from older clients: *"respond with `405 Method Not Allowed`."* | [§Earlier revisions](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#backward-compatibility) |
| Client `Accept` | Client **MUST** list both `application/json` and `text/event-stream` | [§Sending Messages](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#sending-messages) |
| Body | *"**MUST** be a single JSON-RPC request or notification. The client **MUST NOT** send JSON-RPC responses."* | ditto |
| Response to a request | *"the server **MUST** return either `Content-Type: application/json` (a single JSON object) or `Content-Type: text/event-stream` (an SSE response stream). The client **MUST** support both."* — **server picks per request**, so a plain-JSON-only server is conformant | ditto |
| Response to a notification | `202 Accepted` with no body if accepted; an HTTP error status otherwise | ditto |
| `Mcp-Session-Id` | **Gone.** *"An `Mcp-Session-Id` header on a request: ignore it, and do not mint or echo session IDs."* | [§Earlier revisions](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#backward-compatibility) |
| `MCP-Protocol-Version` | *"Every POST request to the MCP endpoint **MUST** include an `MCP-Protocol-Version` header."* It **MUST** match `_meta["io.modelcontextprotocol/protocolVersion"]` or the server **MUST** reject with `400` + `HeaderMismatch` (`-32020`) | [§Protocol Version Header](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#protocol-version-header) |
| `Mcp-Method` / `Mcp-Name` | **REQUIRED** on all requests / on `tools/call`, `resources/read`, `prompts/get` respectively. *"These headers are **REQUIRED** for compliance."* | [§Standard Request Headers](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#standard-request-headers) |
| SSE upgrade semantics | The SSE stream is **scoped to one request**; server **MAY** send `notifications/progress` / `notifications/message` before the final response; *"The server **MUST NOT** send independent JSON-RPC requests on this stream."* Final response **SHOULD** terminate the stream. `X-Accel-Buffering: no` **SHOULD** be set. | [§Receiving Messages](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#receiving-messages) |
| Resumability / `Last-Event-ID` | **Removed.** *"Resumable SSE streams via `Last-Event-ID` are not supported."* Changelog: *"A broken response stream loses the in-flight request; clients **MUST** re-issue it as a new request with a new request ID."* | [§Receiving Messages](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#receiving-messages); [changelog §Major 9](https://modelcontextprotocol.io/specification/2026-07-28/changelog) |
| Cancellation | *"Closing the SSE response stream **MUST** be treated by the server as cancellation of that request."* No `notifications/cancelled` on HTTP. | [§Cancellation](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#cancellation) |
| Long-lived notifications | Only via a `subscriptions/listen` request whose *response* is a long-lived SSE stream | [§Receiving Messages](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#receiving-messages) |

**Why #14 matters for MetaModels specifically.** The header mirroring exists for us. From the release post: methods and tool names travel in `Mcp-Method` and `Mcp-Name` headers, *"enabling gateways, rate limiters, or WAFs to route and meter on those headers instead of parsing JSON bodies."* And the spec adds a caution aimed squarely at intermediaries enforcing policy:

> Intermediaries that enforce policy based on mirrored headers (e.g., routing or rate-limiting by tenant) **SHOULD** verify that the `MCP-Protocol-Version` header indicates a version that requires header–body validation. If the version is older or the header is absent, the intermediary **SHOULD** reject the request rather than trusting unvalidated header values.

([Streamable HTTP §Server Validation](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#server-validation))

That is a direct instruction for a Fence that rate-limits on `Mcp-Name`: **do not trust the header unless the version header says 2026-07-28+.**

### A3. stdio vs HTTP for a remote server; the bridge pattern

stdio is defined as *"the client launches the MCP server as a subprocess"* communicating over that subprocess's `stdin`/`stdout`. It is inherently local by construction: the lifecycle rules are process launch, `stderr`, shutdown-by-closing-stdin, and restart-on-exit. ([stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio))

The spec does, however, explicitly decouple the *framing* from the *streams*:

> Standard streams are the canonical channel, but nothing in this binding depends on them except the process lifecycle. The wire format … works unchanged over Unix domain sockets, TCP connections, or any similar channel.

and, from the transports overview, custom transports over a reliable bidirectional byte stream **SHOULD** reuse the stdio framing.

**Can stdio be remote?** Not as specified — the binding is a subprocess binding. What the ecosystem does instead is run a *local* stdio server that is itself an HTTP client to the remote server (the `mcp-remote` / bridge pattern). The spec does not define this, but it does describe the architecture and warn about it: see [Security Best Practices §stdio Transport Security in Proxy Scenarios](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices), which describes *"proxy architectures where a separate proxy service manages `stdio` connections and can spawn MCP servers as child processes"* and calls it *"a critical escalation path from web-based attacks to full system compromise"* when combined with client-side XSS.

The spec's own guidance for a locally-run server is the mirror image of the bridge: *"Use the `stdio` transport to limit access to just the MCP client"*, or if using HTTP, *"Require an authorization token"* / *"Use unix domain sockets or other IPC mechanisms with restricted access."* (ibid.)

Current state of the bridge pattern across real clients: **see §B9** (researched separately).

### A4. Streamable HTTP security requirements — verbatim

> **Security & Endpoint**
>
> When implementing Streamable HTTP transport:
>
> 1. Servers **MUST** validate the `Origin` header on all incoming connections to prevent DNS rebinding attacks.
>    * If the `Origin` header is present and invalid, servers **MUST** respond with HTTP 403 Forbidden. The HTTP response body **MAY** comprise a JSON-RPC *error response* that has no `id`.
> 2. When running locally, servers **SHOULD** bind only to localhost (127.0.0.1) rather than all network interfaces (0.0.0.0).
> 3. Servers **SHOULD** implement proper authentication for all connections.
>
> Without these protections, attackers could use DNS rebinding to interact with local MCP servers from remote websites.

([Streamable HTTP §Security & Endpoint](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#security-endpoint))

Notes for MetaModels:

- **#1 is a MUST and applies to the public data plane.** The current data plane is API-key-authenticated and presumably has no browser origin concept; adding an MCP endpoint means adding Origin validation. Note the exact conditional: the MUST-403 fires only when Origin is *present and invalid*. A server-to-server client sending no `Origin` is fine.
- **#2 is scoped to *"when running locally"*.** The control plane already satisfies it (binds 127.0.0.1). The data plane on `:8787` is a deliberately public listener and this SHOULD does not apply to it.
- **#3 is a SHOULD that MetaModels already exceeds** — `mm_live_` keys, SHA-256 hashed, scoped to a paddock.

---

## B. Authorization

### B5. What the Authorization spec is, and which RFCs are MUST vs SHOULD

Verbatim protocol requirements:

> Authorization is **OPTIONAL** for MCP implementations. When supported:
>
> * Implementations using an HTTP-based transport **SHOULD** conform to this specification.
> * Implementations using an STDIO transport **SHOULD NOT** follow this specification, and instead retrieve credentials from the environment.
> * Implementations using alternative transports **MUST** follow established security best practices for their protocol.

([Authorization §Protocol Requirements](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization))

Normative strength of each referenced standard, from §Overview:

| Standard | Applies to | Strength | Verbatim |
|---|---|---|---|
| OAuth 2.1 ([draft-ietf-oauth-v2-1-13](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13)) | Authorization servers | **MUST** | *"Authorization servers **MUST** implement OAuth 2.1 with appropriate security measures for both confidential and public clients."* |
| **RFC 9728** Protected Resource Metadata | **MCP servers** | **MUST** | *"MCP servers **MUST** implement OAuth 2.0 Protected Resource Metadata (RFC9728). MCP clients **MUST** use OAuth 2.0 Protected Resource Metadata for authorization server discovery."* |
| **RFC 8414** AS Metadata *or* OIDC Discovery | Authorization servers | **MUST** (at least one) | *"MCP authorization servers **MUST** provide at least one of the following discovery mechanisms: OAuth 2.0 Authorization Server Metadata (RFC8414) [or] OpenID Connect Discovery 1.0"* — and *"MCP clients **MUST** support both"* |
| Client ID Metadata Documents ([draft-00](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00)) | AS + clients | **SHOULD** | *"Authorization servers and MCP clients **SHOULD** support OAuth Client ID Metadata Documents"* |
| **RFC 7591** Dynamic Client Registration | AS + clients | **MAY**, and **DEPRECATED** | *"Authorization servers and MCP clients **MAY** support the OAuth 2.0 Dynamic Client Registration Protocol (RFC7591). Note that Dynamic Client Registration is deprecated and retained for backwards compatibility"* |
| **RFC 8707** Resource Indicators | **MCP clients** | **MUST** | *"MCP clients **MUST** implement Resource Indicators for OAuth 2.0 as defined in RFC 8707"*; the `resource` param **MUST** be in both authorization and token requests, and *"MCP clients **MUST** send this parameter regardless of whether authorization servers support it."* |
| **RFC 9207** AS Issuer Identification | AS **SHOULD**, clients **MUST** validate | mixed | *"MCP authorization servers **SHOULD** include the `iss` parameter … MCP clients **MUST** apply the validation in RFC9207 Section 2.4"* |
| PKCE S256 | MCP clients | **MUST** | *"MCP clients **MUST** implement PKCE … **MUST** use the `S256` code challenge method when technically capable"* and **MUST** refuse to proceed if `code_challenge_methods_supported` is absent |

> **Discrepancy flagged.** My prior belief was that RFC 7591 Dynamic Client Registration was a **SHOULD** for MCP servers. As of 2026-07-28 it is **deprecated**, downgraded to MAY, and superseded by Client ID Metadata Documents ([PR #2858](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2858), [deprecated registry](https://modelcontextprotocol.io/specification/2026-07-28/deprecated)).

**The single load-bearing MUST for a would-be MCP server operator:** if you support MCP authorization at all, you **MUST** serve `/.well-known/oauth-protected-resource` (RFC 9728). Everything else on the list is the Authorization Server's problem, and the AS need not be you.

### B6. AS vs RS, and what changed since 2025-03-26

Verbatim:

> A protected *MCP server* acts as an [OAuth 2.1 resource server](https://www.ietf.org/archive/id/draft-ietf-oauth-v2-1-13.html#name-roles), capable of accepting and responding to protected resource requests using access tokens.
>
> An *MCP client* acts as an OAuth 2.1 client…
>
> The *authorization server* is responsible for interacting with the user (if necessary) and issuing access tokens for use at the MCP server. **The implementation details of the authorization server are beyond the scope of this specification. It may be hosted with the resource server or a separate entity.**

([Authorization §Roles](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#roles))

So: **the MCP server is the Resource Server.** It **may** also be the Authorization Server, but the spec explicitly declines to require or describe that.

**What changed vs 2025-03-26.** The 2025-03-26 revision folded the AS role into the MCP server (it described the MCP server implementing `/authorize`, `/token`, `/register` itself). The split into RS + separate AS, with RFC 9728 discovery as the bridge, was introduced in 2025-06-18 and is carried forward here. I could **not** locate a single normative sentence in the 2026-07-28 documents that narrates this change (the 2026-07-28 changelog only diffs against 2025-11-25) — so the *characterisation* of the 2025-03-26→2025-06-18 shift is **UNVERIFIED against a primary source in this research pass**. What is verified is the *current* position quoted above. If the exact history matters, read the [2025-06-18 changelog](https://modelcontextprotocol.io/specification/2025-06-18/changelog) directly.

### B7. Audience binding and the confused-deputy / passthrough problem

The four normative sentences that matter, verbatim:

> MCP servers, acting in their role as an OAuth 2.1 resource server, **MUST** validate access tokens … **MCP servers MUST validate that access tokens were issued specifically for them as the intended audience**, according to RFC 8707 Section 2.
>
> MCP clients **MUST NOT** send tokens to the MCP server other than ones issued by the MCP server's authorization server.
>
> **MCP servers MUST only accept tokens that are valid for use with their own resources.**
>
> **MCP servers MUST NOT accept or transit any other tokens.**

([Authorization §Token Handling](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#token-handling))

And from the security-considerations page:

> MCP servers **MUST** only accept tokens specifically intended for themselves and **MUST** reject tokens that do not include them in the audience claim or otherwise verify that they are the intended recipient of the token.
>
> If the MCP server makes requests to upstream APIs, it may act as an OAuth client to them. The access token used at the upstream API is a separate token, issued by the upstream authorization server. **The MCP server MUST NOT pass through the token it received from the MCP client.**

([Authz Security Considerations §Access Token Privilege Restriction](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations))

And the Security Best Practices mitigation, which is the shortest form of the rule:

> **MCP servers MUST NOT accept any tokens that were not explicitly issued for the MCP server.**

([Security Best Practices §Token Passthrough](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices#token-passthrough))

**Why this is directly relevant to a governance proxy.** The Token Passthrough section's first listed risk is *Security Control Circumvention*:

> The MCP Server or downstream APIs might implement important security controls like rate limiting, request validation, or traffic monitoring, that depend on the token audience or other credential constraints. If clients can obtain and use tokens directly with the downstream APIs without the MCP server validating them properly … they bypass these controls.

That is a description of MetaModels' entire value proposition stated as a security requirement. It argues *for* MetaModels minting its own credential (`mm_live_`) rather than proxying anyone else's — which is what the current design already does.

**Confused deputy** is narrowly about OAuth proxying: an MCP proxy server with a *static client ID* at a third-party AS, combined with dynamic client registration and a consent cookie, lets an attacker skip the consent screen. Mitigation: *"MCP proxy servers **MUST** implement per-client consent"* — a registry of approved `client_id` per user, checked **before** forwarding to the third-party AS, plus exact-match redirect URI validation and `state` bound after consent. ([Security Best Practices §Confused Deputy](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices#confused-deputy-problem); [Authz Security §Confused Deputy](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations#confused-deputy-problem))

**MetaModels does not have this vulnerability** as long as it does not act as an OAuth proxy to a third-party AS. Ollama and ComfyUI are not OAuth-protected third parties. This whole class of risk is avoided by *not* adopting OAuth.

### B8. Is OAuth required? The exact wording on custom auth

**No.** Three independent statements say so.

1. *"Authorization is **OPTIONAL** for MCP implementations."* ([Authorization §Protocol Requirements](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization))

2. The base protocol's Auth section — this is the key sentence for MetaModels:

   > MCP provides an [Authorization](/specification/2026-07-28/basic/authorization) framework for use with HTTP. Implementations using an HTTP-based transport **SHOULD** conform to this specification, whereas implementations using STDIO transport **SHOULD NOT** follow this specification, and instead retrieve credentials from the environment.
   >
   > **Additionally, clients and servers MAY negotiate their own custom authentication and authorization strategies.**

   ([Base Protocol §Auth](https://modelcontextprotocol.io/specification/2026-07-28/basic/index))

3. The transport-level requirement is only *"Servers **SHOULD** implement proper authentication for all connections"* — scheme unspecified. ([Streamable HTTP §Security & Endpoint](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#security-endpoint))

**Precise verdict for a static `Authorization: Bearer mm_live_...`:**

- It is **not non-conformant.** The spec's explicit "MAY negotiate their own custom authentication and authorization strategies" covers it.
- It is **not fully conformant with the Authorization specification**, because that document is opt-in and, once opted into, imposes RFC 9728 etc. A static API key is a *custom strategy*, i.e. deliberately **outside** that document, which the base spec permits by name.
- The honest framing is: **out of scope of the authorization spec, explicitly permitted by the base spec, and a SHOULD-not-followed on the "HTTP transports SHOULD conform" line.** A "SHOULD" is not a "MUST"; departing from it with a documented reason is legitimate per BCP 14, which the spec adopts by reference.
- Practical cost of departing is **not** conformance — it is **client compatibility** (§B9).

**One thing a static key does NOT excuse you from:** the token-audience and passthrough rules exist for OAuth tokens, but their *intent* (never forward a caller's credential to the upstream) applies just as much. MetaModels must not forward `mm_live_` to Ollama.

### B9. What MCP clients actually support today

**Headline: a static bearer token works in five of the seven clients checked, with no OAuth machinery at all.** The "you must implement OAuth to be a remote MCP server" folk wisdom is false as of today.

| Client | Transports | Static bearer / custom header? | OAuth required? | Cite |
|---|---|---|---|---|
| **Claude Code** | stdio, `http` (Streamable HTTP), `sse` (deprecated), `ws` | **Yes** — `--header` / `-H` on `claude mcp add`; `headers` in `.mcp.json` with `${VAR}` expansion | **No.** OAuth engages only if the server answers 401/403 | [code.claude.com/docs/en/mcp](https://code.claude.com/docs/en/mcp) |
| **Claude.ai / Desktop custom connectors** | Streamable HTTP + SSE (auto-detected from URL) | **Yes, but BETA and org-gated** — "Request headers" section | No — auth can be `None` + a request header | [claude.com/docs/connectors/custom/remote-mcp](https://claude.com/docs/connectors/custom/remote-mcp), [authentication](https://claude.com/docs/connectors/building/authentication) |
| **OpenAI Responses API `type:"mcp"`** | Streamable HTTP **or** HTTP/SSE | **Yes** — a `headers` map exists in the API reference (the guide page omits it) | No | [API reference](https://developers.openai.com/api/docs/api-reference/responses/create) |
| **VS Code (Copilot agent mode)** | `stdio`, `http`, `sse`; `http` tries HTTP Stream then falls back to SSE | **Yes** — `headers`, documented example `{"Authorization": "Bearer ${input:api-token}"}` | No — `oauth` block optional | [MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) |
| **Cursor** | stdio, SSE, Streamable HTTP | **Yes** — `headers` object, `${env:NAME}` interpolation | No, **but see caveat** | [cursor.com/docs/mcp](https://cursor.com/docs/mcp) |
| **Gemini CLI** | stdio (`command`), SSE (`url`), Streamable HTTP (`httpUrl`) | **Yes** — `headers` object; `-H` / `--header` flag | No | [Gemini CLI MCP servers](https://google-gemini.github.io/gemini-cli/docs/tools/mcp-server.html) |
| **ChatGPT custom connectors** (developer mode) | "SSE and streaming HTTP" | **Not documented** — options are OAuth / No auth / Mixed | Effectively **yes**, or authless | [OpenAI developer mode](https://developers.openai.com/api/docs/guides/developer-mode) |

**Claude Code, verbatim from the docs** — this is the shape a MetaModels paddock would be added with:

```bash
claude mcp add --transport http secure-api https://api.example.com/mcp \
  --header "Authorization: Bearer your-token"
```

Short forms `-t`, `-H`, `-s`, `-e`. `--transport sse` still exists but the docs label it deprecated: *"The SSE (Server-Sent Events) transport is deprecated. Use HTTP servers instead, where available."* Claude Code marks a server as needing authentication only when it *"responds with `401 Unauthorized` or `403 Forbidden`"* — so a server that accepts the supplied header never enters an OAuth path. `.mcp.json` supports `${VAR}` / `${VAR:-default}` expansion inside `headers`, so the key need not be committed. ([Claude Code MCP docs](https://code.claude.com/docs/en/mcp))

**Claude.ai / Desktop connectors — the one important asterisk.** Static headers exist but are gated:

> Request header authentication is in beta and available to a limited set of organizations. If you don't see the **Request headers** section in the Add custom connector dialog, your organization doesn't have access yet.

Mechanics that constrain a `mm_live_` design: the value is sent **verbatim with no scheme prepended** (enter `Bearer mm_live_...`); header names outside the standard set (`authorization`, `x-api-key`, `x-auth-token`) **require Anthropic review**; max four headers; auth settings are immutable after add; the credential is **org-shared, not per-user**; and connectors dial out from Anthropic's cloud (egress `160.79.104.0/21`), so the server must be publicly reachable. ([custom remote MCP](https://claude.com/docs/connectors/custom/remote-mcp), [connector authentication](https://claude.com/docs/connectors/building/authentication))

That last point is a real constraint for a *self-hosted* product: a MetaModels data plane behind a home LAN cannot be a Claude.ai connector without a public ingress. Claude Code, by contrast, runs on the user's machine and can reach `192.168.1.x` directly.

**If you ever do OAuth for the Claude surfaces**, the non-negotiables are: `401` + `WWW-Authenticate: Bearer resource_metadata="..."`, an RFC 9728 document whose `resource` exactly matches the entered URL, only `authorization_servers[0]` is tried, RFC 8414/OIDC discovery on the AS, PKCE S256 advertised, and port-agnostic matching for both `http://localhost/callback` and `http://127.0.0.1/callback`. Pure `client_credentials` M2M is **not supported**. ([connector authentication](https://claude.com/docs/connectors/building/authentication))

**Is `mcp-remote` still needed?** **Not by any client above** — all six speak remote HTTP natively and accept headers directly. Flagged discrepancy: the [`mcp-remote` README](https://github.com/geelen/mcp-remote) still claims *"most are stdio-only, and those that do support HTTP+SSE don't yet support the OAuth flows required"*, naming Claude Desktop, Cursor and Windsurf. That text is **stale relative to those clients' own current docs**. The project is not archived (v0.8.3 shipped 2026-08-31) and remains useful for stdio-only clients outside this list, but MetaModels should not design around it.

**UNVERIFIED items from this sweep:**
- **Cursor**: its own docs are internally ambiguous — the transport table's Auth column says "OAuth" for SSE/Streamable HTTP while `headers` is documented for remote servers. Whether headers are honored when the server advertises OAuth discovery could not be confirmed from first-party docs. Test explicitly.
- **Gemini CLI**: `${VAR}` expansion *inside* `headers` (expansion is documented only for the `env` block; an upstream feature request suggests it may not work).
- **Claude.ai connectors**: whether the `static_headers` beta reaches individual Free/Pro/Max users or is admin-only.

---

## C. Per-tool authorization for a policy gateway

### C10. Built-in per-tool authz and scopes: there is none

**Finding: MCP has no built-in per-tool authorization or scope model.** Evidence:

- The `Tool` interface in `schema.ts` has exactly these fields: `name`/`title` (from `BaseMetadata`), `icons`, `description`, `inputSchema`, `outputSchema`, `annotations`, `_meta`. There is no scope, permission, role, or ACL field. ([schema.ts](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts))
- `grep -i scope schema.ts` matches only `cacheScope` (a caching directive: `"public" | "private"`). Verified locally against the fetched `2026-07-28/schema.ts`.
- The only scope machinery in the whole spec lives in the OAuth layer, as `WWW-Authenticate` challenges, not as tool metadata. ([Authorization §Scope Selection Strategy](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#scope-selection-strategy))

So a policy gateway has exactly **two** conformant levers:

1. **Filter `tools/list` by credential** (see C11 — explicitly blessed).
2. **Reject at `tools/call`** — either as a tool execution error (`isError: true`, model-recoverable) or, if using OAuth, `403` + `WWW-Authenticate: Bearer error="insufficient_scope", scope="..."` for a step-up flow. ([Authorization §Runtime Insufficient Scope Errors](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#scope-challenge-handling))

Note the spec explicitly lists *"Treating claimed scopes in token as sufficient without server-side authorization logic"* as a **Common Mistake**. Server-side enforcement — i.e. the Fence — is mandatory regardless of what the tool list said. ([Security Best Practices §Scope Minimization](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices#scope-minimization))

### C10b. Tool annotations: what they mean and whether you can trust them

The four hints, verbatim from `schema.ts` `ToolAnnotations`:

| Field | Doc comment | Default |
|---|---|---|
| `readOnlyHint` | *"If true, the tool does not modify its environment."* | `false` |
| `destructiveHint` | *"If true, the tool may perform destructive updates to its environment. If false, the tool performs only additive updates. (This property is meaningful only when `readOnlyHint == false`)"* | **`true`** |
| `idempotentHint` | *"If true, calling the tool repeatedly with the same arguments will have no additional effect on its environment. (meaningful only when `readOnlyHint == false`)"* | `false` |
| `openWorldHint` | *"If true, this tool may interact with an 'open world' of external entities. If false, the tool's domain of interaction is closed."* | **`true`** |

(also `title`, a display name.) Note the two *unsafe-by-default* defaults: an unannotated tool is assumed destructive and open-world.

**Trustworthiness — this is the important part.** The spec:

> For trust & safety and security, clients **MUST** consider tool annotations to be untrusted unless they come from trusted servers.

([Tools §Tool](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#tool))

And the spec index, in Key Principles → Tool Safety:

> In particular, descriptions of tool behavior such as annotations should be considered untrusted, unless obtained from a trusted server.

([spec index](https://modelcontextprotocol.io/specification/latest))

The official blog post is the clearest statement of the boundary:

- *"annotations are not guaranteed to faithfully describe tool behavior"*
- *"An untrusted server can lie. A server can claim `readOnlyHint: true` and delete your files anyway."*
- *"If you need a guarantee that a tool can't exfiltrate data, that's a job for network controls or sandboxing, not a boolean hint."*
- *"They don't make the model resist prompt injection. Annotations are static metadata on a tool definition; nothing in them tells the model to ignore malicious instructions."*
- *"A tool's risk depends on what else is in the session… Annotations on one tool can't tell you that."*

([Tool Annotations as Risk Vocabulary](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/))

**Design consequence for MetaModels:** annotations are output, not input. Emit them (they improve client UX and can *"feed policy engines"* on the client side), but the Fence must never read an annotation to decide anything — the Fence is the trusted server, and its enforcement is in `guard()`, not in metadata.

### C11. Dynamic tool lists per credential — explicitly permitted

This is the single most important finding for the `toMcp` design. Verbatim:

> Servers that declare the `tools` capability **MUST** respond to `tools/list` requests with the set of tools currently available to the requesting client. This set **MAY** be empty and **MAY** change over time (see List Changed Notification), but **MUST NOT** vary per-connection or as a side effect of other requests on the connection. **The set MAY vary by the authorization presented on the request — for example, returning only the tools the caller's granted scopes permit — since credentials are per-request input, not connection state.**

([Tools §Capabilities](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#capabilities))

Read the distinction carefully, because it is the whole design constraint:

- ❌ **Not allowed:** "this connection called X, so now the tool list is different" — connection-derived state.
- ✅ **Allowed:** "this request presented key `mm_live_abc`, whose paddock's fence permits route classes {chat, embeddings} and models {llama3, qwen}, therefore this tool list."

`toMcp?(fence: C): unknown[]` (defined at `packages/connectors/src/breed.ts:107`) is a **pure function of the fence**, which is a pure function of the presented credential. That is precisely the permitted shape. Confirmed against the repo.

Two supporting requirements that constrain the implementation:

1. **Deterministic ordering.** *"Servers **SHOULD** return tools from `tools/list` in a deterministic order to enable client-side caching and improve LLM prompt cache hit rates."* So `toMcp` must emit a stable order — do not iterate a `Map` whose insertion order depends on fence evaluation order. ([changelog §Minor 3](https://modelcontextprotocol.io/specification/2026-07-28/changelog))

2. **Caching, with a private scope.** `tools/list` results now **require** `ttlMs` and `cacheScope`. Since our list varies by credential, `cacheScope` **MUST** be `"private"`. Verbatim from `schema.ts`:

   > `"public"`: The response does not contain user-specific data. Any client or intermediary (e.g., shared gateway, caching proxy) MAY cache the response and serve it across authorization contexts.
   > `"private"`: The response MAY be cached and reused only within the same authorization context. **Caches MUST NOT be shared across authorization contexts (e.g., a different access token requires a different cache).**

   Marking a fence-derived tool list `"public"` would invite an intermediary to serve one paddock's tool list to another. ([changelog §Minor 5](https://modelcontextprotocol.io/specification/2026-07-28/changelog); [schema.ts `CacheableResult`](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts))

**Is `notifications/tools/list_changed` the mechanism for changes?** Yes, but it is now *pull-based on the client's terms* and **optional for us**:

> When the list of available tools changes, servers that declared the `listChanged` capability **SHOULD** send a notification to clients that have opened a `subscriptions/listen` stream with `toolsListChanged: true`.

([Tools §List Changed Notification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#list-changed-notification))

The old standalone `GET` SSE stream is gone; a client that wants change notifications must POST `subscriptions/listen` and hold that response stream open. **A server that simply declares `tools: {}` (no `listChanged`) never has to implement `subscriptions/listen` or any SSE at all.** For MetaModels v1, where fences change via the admin UI and not second-by-second, declaring `listChanged: false` and relying on `ttlMs` is a legitimate and much cheaper choice.

### C12. Documented security pitfalls relevant to a gateway proxying an LLM backend

The canonical page is [Security Best Practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices). Its sections, and their relevance to MetaModels:

| Pitfall | Relevance | Key normative text |
|---|---|---|
| **Confused Deputy** | Low — only if we become an OAuth proxy to a third-party AS. We aren't. | *"MCP proxy servers **MUST** implement per-client consent"* |
| **Token Passthrough** | **High.** Our whole model is credential translation. | *"MCP servers **MUST NOT** accept any tokens that were not explicitly issued for the MCP server."* |
| **SSRF** | Medium — aimed at MCP *clients* fetching OAuth discovery URLs. Relevant if MetaModels ever acts as an MCP client. Also note the recommended blocklist includes `192.168.0.0/16` — which is where the Ollama box lives; that blocklist is about OAuth discovery URLs, not upstream data-plane targets. | *"MCP clients **SHOULD** block requests to private and reserved IP address ranges"* |
| **State Handle Hijacking** (replaces §Session Hijacking) | **High**, if we ever mint job handles for ComfyUI. | *"MCP servers that implement authorization **MUST** verify all inbound requests. MCP servers **MUST NOT** treat possession of a state handle as authentication."* and *"**SHOULD** bind handles server-side to the authenticated user, for example by keying stored state as `<user_id>:<handle>`"* |
| **Local MCP Server Compromise** | Low for us as a server; relevant guidance is *"Restrict access if using an HTTP transport, such as: Require an authorization token"* | ibid. |
| **OAuth Authorization URL Validation** | N/A (client-side) | — |
| **stdio Transport Security in Proxy Scenarios** | N/A unless we ship a bridge | — |
| **Mix-Up Attacks / Localhost Redirect Impersonation / CIMD Trust Policies** | N/A (OAuth-only) | — |
| **Scope Minimization** | Medium — the model maps onto Fences neatly if we ever do OAuth | *"Treating claimed scopes in token as sufficient without server-side authorization logic"* is listed as a Common Mistake |

**Session hijacking via `Mcp-Session-Id`: this section no longer exists in the current revision.** It was replaced by *State Handle Hijacking*, which opens:

> MCP is [stateless] and has no protocol-level sessions. Servers that need state spanning multiple requests mint an explicit handle … State handle hijacking is an attack vector where an unauthorized party obtains or guesses such a handle and uses it to access or modify another user's state.

The old guidance is preserved only as an archive link, for *"the server-assigned session IDs used by protocol version `2025-11-25` and earlier."* ([Security Best Practices §State Handle Hijacking](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices))

**Tool poisoning / prompt injection via tool descriptions: this is NOT a section of the Security Best Practices page.** I checked the full page and it is absent. What the spec *does* say lives in two places:

- The spec index, Key Principles → Tool Safety: *"Tools represent arbitrary code execution and must be treated with appropriate caution. In particular, descriptions of tool behavior such as annotations should be considered untrusted, unless obtained from a trusted server."* ([spec index](https://modelcontextprotocol.io/specification/latest))
- The Tool Annotations post: *"They don't make the model resist prompt injection."* ([post](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/))

Beyond that, tool-poisoning mitigation is an **open community topic, not settled spec** — e.g. [Discussion #2457, "Client-Side Tool Description Substitution as a Defense Against Indirect Prompt Injection in MCP"](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/2457). **Flagged: there is no normative MCP requirement addressing tool poisoning.** If MetaModels wants a claim here, it is our own control, not a conformance point.

**The MetaModels-specific angle nobody's spec covers:** we would be a server whose tool *outputs* are LLM completions from Ollama. Injected content in a completion flows back through `tools/call` into the calling model's context. The spec's only handle on this is the client-side SHOULD *"Validate tool results before passing to LLM"* ([Tools §Security Considerations](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#security-considerations)) — which is the client's job, not ours, and in practice nobody does it. Worth naming as a residual risk rather than pretending the spec solves it.

The server-side security MUSTs from the Tools page are, notably, a description of what a Fence already is:

> Servers **MUST**: Validate all tool inputs · Implement proper access controls · **Rate limit tool invocations** · Sanitize tool outputs

([Tools §Security Considerations](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#security-considerations))

### C13. Elicitation / sampling / roots — and whether a policy gateway needs them

**What they are.** All three are *client* features that a server can ask the client to perform:

- **Elicitation** — `elicitation/create`: the server asks the client to collect structured input from the **user** against a `requestedSchema` (e.g. "provide your GitHub username"). Still Active.
- **Sampling** — `sampling/createMessage`: the server asks the **client's LLM** to run a completion on the server's behalf. **Deprecated** as of 2026-07-28; suggested migration *"Integrate directly with LLM provider APIs."*
- **Roots** — `roots/list`: the server asks the client which filesystem roots it may operate in. **Deprecated** as of 2026-07-28; suggested migration *"Pass directories or files via tool parameters, resource URIs, or server configuration."*

([deprecated registry](https://modelcontextprotocol.io/specification/2026-07-28/deprecated); [changelog §Deprecated 1](https://modelcontextprotocol.io/specification/2026-07-28/changelog))

**How they now work.** Server-initiated JSON-RPC requests are gone — *"Servers **MUST** send server-to-client requests (such as `roots/list`, `sampling/createMessage`, or `elicitation/create`) using the MRTR pattern. The previous pattern of server-initiated requests is no longer supported. This is a breaking change."* Instead the server returns `resultType: "input_required"` with an `inputRequests` map and an opaque `requestState`; the client gathers the input and **retries the original request with a new JSON-RPC id**, echoing `requestState` verbatim. ([MRTR](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr))

**Would a policy gateway need them?** Almost certainly not, and there is a strong argument to skip all three. Sampling is redundant — MetaModels *is* the LLM path, so asking the client's model to generate is backwards, and it's deprecated anyway. Roots is meaningless: there is no filesystem in a Flock→Paddock→Fence model, and it's deprecated. Elicitation is the only live candidate — one could imagine "this paddock's quota is exhausted; ask the user to confirm an overage" — but it costs real complexity: the server **MUST NOT** send an `inputRequests` the client hasn't declared support for, and if `requestState` *"influences authorization, resource access, or business logic, servers **MUST** protect its integrity (e.g. HMAC or AEAD) and **MUST** reject state that fails verification"*, plus **SHOULD** bind the authenticated principal, a TTL, and a request digest into it to prevent replay. For a gateway whose answer to "over quota" should be a deterministic `429`, that is a lot of cryptographic machinery to buy a confirmation dialog. **Recommendation: declare none of the three; return errors, not questions.**

---

## D. Reference implementations and the SDK question

### D14. How existing AI gateways ship an MCP surface

Six gateways with public docs and/or source were examined. **Every mature one filters tools per credential, every one but Cloudflare accepts a static API key on its MCP endpoint, and Streamable HTTP at `/mcp` is the near-universal shape.**

| Gateway | MCP? | Role | Transport | Auth on the MCP endpoint | Per-key/team tool filtering |
|---|---|---|---|---|---|
| **LiteLLM proxy** (BerriAI, public source) | Yes | **Gateway/passthrough** (aggregates configured MCP servers and re-exposes them) **+ client** (MCP tools callable from `/v1/chat/completions`) | Streamable HTTP (stateful + stateless) and SSE; plus non-MCP REST shims | **Static API key** — `x-litellm-api-key: Bearer <key>`; bare `Authorization` also accepted for back-compat. Upstream creds carried separately as `x-mcp-{server_alias}-{header}` | **Yes, extensively** — 6-level intersection (key / team / end-user / agent / internal-user / org ceiling) |
| **Portkey** | Yes | **Gateway/passthrough** (MCP Gateway fronting internal + external servers) | *"HTTP Streamable transport for all connections"* — Streamable HTTP only | **Static API key** — `x-portkey-api-key`, workspace-scoped, needs an *MCP Invoke* permission. OAuth 2.1 / DCR / JWT are used northbound to upstreams, not demanded of the client | Yes — workspace scoping + per-key MCP permissions |
| **Cloudflare** | Yes (two products) | (a) `agents` SDK / `McpAgent` = **MCP server** authoring; (b) **MCP Server Portals** (Cloudflare One) = **gateway/passthrough** | Portal serves Streamable HTTP at `/mcp`, accepting **stateless MCP 2026-07-28** as well as 2025-era clients | **OAuth-first, the outlier.** `workers-oauth-provider` with `/authorize`, `/token`, `/register`; Portals use Access OAuth + `401` + `WWW-Authenticate`. Machine-to-machine uses Access **service tokens** | Yes for Portals — per-server Access policies, admin-chosen tool subsets |
| **Kong AI Gateway** (`ai-mcp-proxy`, **Enterprise-tier**, 3.12+) | Yes | All three, by `config.mode`: passthrough, REST→MCP conversion, or aggregation | Streamable HTTP (cites the 2025-06-18 transport spec; still uses `Mcp-Session-Id`) | Delegated to ordinary Kong auth plugins (Key Auth, OIDC, `ai-mcp-oauth2`). No MCP-specific header | **Yes** — `config.default_acl` + `config.tools[].acl.allow/deny`, deny-first, keyed on Consumer or OAuth token claims |
| **Docker MCP Gateway** (MIT, public source) | Yes | **Gateway/passthrough** to containerised servers | **stdio** by default; `--transport streaming` with `--port` | Local/desktop trust model. **No documented inbound auth on the gateway itself** | Per-**profile**, not per-credential: `docker mcp profile tools <id> --enable <server>.<tool>` |
| **IBM ContextForge** (Apache-2.0, public source) | Yes | **Gateway/registry/proxy** federating MCP, A2A, REST/gRPC | HTTP/JSON-RPC, WebSocket, SSE, stdio, Streamable HTTP | **Static credentials** — JWT bearer (`JWT_SECRET_KEY`) or HTTP Basic; OAuth for user-scoped tokens; `X-Upstream-Authorization` passthrough | Yes — "virtual servers" bundling `associatedTools`, per-team isolation |

**Four transferable design lessons, in rough order of value to MetaModels:**

1. **A custom header for the gateway key, leaving `Authorization` free.** LiteLLM uses `x-litellm-api-key`, Portkey uses `x-portkey-api-key`. This keeps `Authorization` available to carry an upstream credential and removes ambiguity about which principal a bearer token names. MetaModels could adopt `x-metamodels-key` (or keep `Authorization` and accept the ambiguity — but see #2).
2. **Never forward a bare `Authorization` upstream.** LiteLLM's source carries an explicit guard and comment to this effect — if `x-litellm-api-key` is absent, a bare `Authorization` is treated as the *proxy's own key* and deliberately **not** forwarded, because *"forwarding it upstream would leak the proxy key to a third-party MCP server."* This is the same rule the MCP spec states normatively as the token-passthrough prohibition (§B7), independently rediscovered in production. Worth copying verbatim into the Fence.
3. **URL namespacing so a client can scope itself without a header.** LiteLLM exposes `/<server_alias>/mcp`, `/<access_group>/mcp`, and comma-separated multi-server paths. MetaModels already has exactly this shape in `/p/<slug>` — so `POST /p/<slug>/mcp` is both the idiomatic gateway pattern and a one-line addition to the existing `app.all('/p/:slug/*', …)` route in `apps/data-plane/src/app.ts`.
4. **Per-credential tool filtering is table stakes, and the default should be closed.** LiteLLM ships `general_settings.require_key_mcp_access_defined: true` to flip the default from open to closed. A Fence-derived tool list is closed-by-default by construction, which is the stronger position.

**Readable prior art**, if the team wants to study an implementation: LiteLLM (`litellm/proxy/_experimental/mcp_server/server.py`), [docker/mcp-gateway](https://github.com/docker/mcp-gateway) (MIT), [IBM/mcp-context-forge](https://github.com/IBM/mcp-context-forge) (Apache-2.0). Kong's MCP work is Enterprise-only and not readable.

**UNVERIFIED / not found:** Cloudflare **AI Gateway** (the LLM-proxy product specifically) has no MCP mention on its docs landing page — Cloudflare's MCP work lives in the `agents` SDK and Cloudflare One, not in AI Gateway. Kong's MCP path is route-defined rather than a fixed `/mcp`. OpenRouter, Envoy AI Gateway and Traefik were not examined in this pass.

Sources: [LiteLLM MCP](https://docs.litellm.ai/docs/mcp) · [LiteLLM MCP access control](https://docs.litellm.ai/docs/mcp_control) · [LiteLLM `mcp_server/server.py`](https://raw.githubusercontent.com/BerriAI/litellm/main/litellm/proxy/_experimental/mcp_server/server.py) · [Portkey MCP Gateway](https://portkey.ai/docs/product/mcp-gateway) · [Portkey MCP auth](https://portkey.ai/docs/product/mcp-gateway/authentication) · [Cloudflare agents MCP](https://developers.cloudflare.com/agents/model-context-protocol/) · [Cloudflare MCP authorization](https://developers.cloudflare.com/agents/model-context-protocol/authorization/) · [Cloudflare MCP Server Portals](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/) · [Kong `ai-mcp-proxy`](https://developer.konghq.com/plugins/ai-mcp-proxy/) · [Kong `ai-mcp-proxy` reference](https://developer.konghq.com/plugins/ai-mcp-proxy/reference/) · [docker/mcp-gateway](https://github.com/docker/mcp-gateway) · [IBM/mcp-context-forge](https://github.com/IBM/mcp-context-forge)

### D15. The official TypeScript SDK, and the honest hand-roll cost

**The premise of the question has changed: `@modelcontextprotocol/sdk` is now the *legacy v1 line*, and it does not implement the current spec.**

| | `@modelcontextprotocol/sdk` (v1) | `@modelcontextprotocol/server` (v2) |
|---|---|---|
| Version / published | **1.30.0**, 2026-07-27 | **2.0.0**, 2026-07-27 |
| License | package.json says **MIT**; repo `LICENSE` states the project *"is undergoing a licensing transition from the MIT License to the Apache License, Version 2.0"*, so GitHub reports `NOASSERTION` | MIT |
| Direct dependencies | **17** — `ajv`, `ajv-formats`, `content-type`, `cors`, `cross-spawn`, `eventsource`, `eventsource-parser`, `express`, `express-rate-limit`, `hono`, `@hono/node-server`, `jose`, `json-schema-typed`, `pkce-challenge`, `raw-body`, `zod`, `zod-to-json-schema` | **2** — `zod ^4.2.0` and `@modelcontextprotocol/core@2.0.0` (whose only dep is `zod`) |
| Transitive install | **~93 packages** beyond the SDK (clean `npm install` into a scratch dir, `lockfileVersion 3`) | a `zod`-only tree |
| Weekly downloads | **52,072,511** (week of 2026-08-23) | 5.03M (`server`), 5.37M (`core`), 3.76M (`client`) |
| Implements 2026-07-28? | **No.** Installed `dist/esm/types.js` has `LATEST_PROTOCOL_VERSION = '2025-11-25'` and `SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25','2025-06-18','2025-03-26','2024-11-05','2024-10-07']`. **Zero** occurrences of `2026-07-28` or `server/discover` anywhere in `dist/` | **Yes** — `DiscoverResultSchema`, `server/discover`, `SubscriptionsAcknowledgedNotificationSchema` and the 2026-07-28 `ResultMetaObject` are all present in the published `core@2.0.0` bundle |

The repo is now a monorepo (`packages/{core,client,server,server-legacy,middleware,codemod,…}`) and its [`docs/protocol-versions.md`](https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/docs/protocol-versions.md) describes the same two-era model the spec does — `legacy` (2024-10-07 … 2025-11-25, `initialize` handshake) and `modern` (2026-07-28) — with an explicit `versionNegotiation: { mode: 'auto' | 'legacy' | { pin: '2026-07-28' } }` switch. Repo: [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) (13.3k stars, pushed 2026-09-06).

> **Discrepancy flagged, and it is the one most likely to cause a wrong decision.** The widely-held belief — mine included — that "the TypeScript SDK is one package, `@modelcontextprotocol/sdk`, and it drags in Express" is **out of date**. Choosing v1 today would (a) pull ~93 packages including `express`, `cors`, `ajv`, `eventsource`, `cross-spawn` and `jose` into an AGPL self-hosted proxy's tree, and (b) **still not speak the current protocol revision.**
>
> One gotcha: `LATEST_PROTOCOL_VERSION` in `core@2.0.0` is *still* the string `"2025-11-25"`. In v2 that constant means *latest legacy-era revision*, not *latest spec*. Do not read it as a support claim either way.

**What this does to the zero-new-dependency calculus.** The real comparison is no longer "hand-roll vs. a 93-package Express tree." It is:

- **Hand-roll:** 0 new dependencies. Three method handlers + ~12 validation rules (below). Full control of the Fence integration. We own conformance and every future revision.
- **`@modelcontextprotocol/server@2.x`:** **2 direct dependencies**, one of which (`zod`) is already a dependency of every workspace package in this repo — so the true marginal cost is `@modelcontextprotocol/core`, a single `zod`-only package. It speaks 2026-07-28 today and gives dual-era support via a config switch, which is the expensive part to hand-roll (see below).

That is a genuinely close call rather than the foregone conclusion it would have been against v1. **Note the version constraint mismatch to check before adopting:** v2 requires `zod ^4.2.0`; this repo pins `zod ^3.23.0` across `packages/schema`, `packages/connectors`, `apps/control-plane` and `apps/data-plane`. A zod 3→4 major upgrade across the workspace is a real cost that belongs in the comparison, and it is the single strongest argument left for hand-rolling.



#### The wire protocol you would be hand-rolling

This half is derived from the spec directly and is independent of whatever the SDK numbers turn out to be.

**Methods a minimal spec-conformant 2026-07-28 tools-only server MUST implement.** The complete set of methods in `schema.ts` is:

```
server/discover          tools/list        tools/call
prompts/list             prompts/get       resources/list
resources/read           resources/templates/list
completion/complete      subscriptions/listen
roots/list  sampling/createMessage  elicitation/create   (client-side, deprecated except elicitation)

notifications/cancelled              notifications/progress
notifications/message                notifications/tools/list_changed
notifications/prompts/list_changed   notifications/resources/list_changed
notifications/resources/updated      notifications/subscriptions/acknowledged
```

(verified by `grep -oE 'method: "[a-zA-Z/_]+"' schema.ts` against the fetched `2026-07-28/schema.ts`)

For a tools-only server that declares `capabilities: { tools: {} }`, the **mandatory** surface is only:

| Method | Why mandatory | Cite |
|---|---|---|
| `server/discover` | *"Servers **MUST** implement `server/discover`."* Returns `supportedVersions`, `capabilities`, optional `instructions`, `ttlMs`, `cacheScope`, and `_meta["io.modelcontextprotocol/serverInfo"]` | [Discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover) |
| `tools/list` | *"Servers that declare the `tools` capability **MUST** respond to `tools/list` requests"* | [Tools §Capabilities](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#capabilities) |
| `tools/call` | The point of the exercise | [Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) |

**Everything else is genuinely optional**, and several things that used to be mandatory are simply gone:

- ❌ `initialize` + `notifications/initialized` — **removed**, no handshake exists
- ❌ `ping` — **removed** in this revision ([changelog §Major 5](https://modelcontextprotocol.io/specification/2026-07-28/changelog))
- ❌ `logging/setLevel` — **removed**; log level is now per-request via `_meta["io.modelcontextprotocol/logLevel"]`
- ❌ session creation/termination — no sessions
- ❌ `Last-Event-ID` resumption / event-id bookkeeping — removed
- ⭕ `subscriptions/listen` — only needed if you declare `tools: { listChanged: true }`
- ⭕ SSE entirely — only needed for progress notifications or long-lived subscriptions. **A server that answers every `tools/call` with a single `application/json` object is conformant**, since the spec says the server returns *"either"* content type and the client **MUST** support both.

**Handshake and version-negotiation rules to implement:**

1. There is no handshake. *"There is no negotiation handshake. Every request carries its protocol version, and the server accepts or rejects each request independently."* ([Versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning))
2. Read `_meta["io.modelcontextprotocol/protocolVersion"]` (**required**) and `_meta["io.modelcontextprotocol/clientCapabilities"]` (**required**). `clientInfo` and `logLevel` are optional. A request missing a required field **MUST** be rejected with `-32602` and HTTP `400`.
3. Validate the `MCP-Protocol-Version` header **equals** the body value, else `400` + `-32020` `HeaderMismatch`.
4. Validate `Mcp-Method` equals `method`, and `Mcp-Name` equals `params.name` for `tools/call` — decoding the `=?base64?...?=` sentinel first. Mismatch or missing ⇒ `400` + `-32020`.
5. Unsupported version ⇒ `400` + `-32022` `UnsupportedProtocolVersionError` with `data: { supported: [...], requested: "..." }`.
6. Unknown method ⇒ **HTTP `404`** (not 400) + JSON-RPC `-32601`. This is deliberate, to distinguish from a legacy HTTP+SSE 404.
7. If a request needs a client capability that wasn't declared ⇒ `-32021` `MissingRequiredClientCapability` + HTTP `400`.
8. Every result **MUST** carry `resultType: "complete"`. `tools/list` results **MUST** additionally carry `ttlMs` and `cacheScope` (use `"private"` — see §C11).
9. Servers **SHOULD** include `_meta["io.modelcontextprotocol/serverInfo"]` in every result.
10. `Origin` present and invalid ⇒ HTTP `403`.
11. `GET` / `DELETE` on the endpoint ⇒ `405`. Ignore any `Mcp-Session-Id` or `Last-Event-ID`.

**Honest assessment.** For a modern-only, tools-only, JSON-response-only server this is roughly *three JSON-RPC method handlers plus about a dozen validation rules*, over a single POST route. There is no state machine, no session store, no SSE, no reconnection logic, no event-id bookkeeping. In a Hono data plane that already parses JSON bodies and authenticates `mm_live_` keys, this is a small, self-contained module — the sort of thing the repo's zero-new-dependency norm exists to make possible. **The 2026-07-28 statelessness rewrite is what makes hand-rolling defensible; it would have been a much worse idea against 2025-11-25.**

**Where the cost actually is** — and this is the part to weigh, not the JSON-RPC:

- **Dual-era support.** If MetaModels must work with clients still speaking `2025-11-25` or earlier, you additionally implement the `initialize` handshake, `Mcp-Session-Id` minting and DELETE termination, the standalone `GET` SSE stream, server-initiated requests on SSE, and `Last-Event-ID` resumability — i.e. *the entire protocol that was just deleted*, in parallel. That roughly triples the work and is where an SDK earns its keep. The compatibility matrix is blunt: **Legacy client → Modern server: "Fails."** ([Versioning §Compatibility Matrix](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning#compatibility-matrix))
- **No spec deadline helps you here.** The feature-lifecycle policy explicitly *"governs **features** of the MCP core specification"* and defers the revision lifecycle to the versioning guide. There is no normative statement about how long a server must support older *revisions*. Dual-era support is a market decision, not a conformance one. ([feature lifecycle §Scope](https://modelcontextprotocol.io/community/feature-lifecycle))
- **The `x-mcp-header` client obligation.** *"While the use of `x-mcp-header` is optional for servers, clients **MUST** support this feature."* We are a server, so we can ignore it — but note it exists and is a natural fit if a Fence ever wants to route on a tool argument.
- **`$ref` and composition-keyword hardening.** If tool `inputSchema`s ever come from a connector rather than being hardcoded: *"Implementations **MUST NOT** automatically dereference `$ref` values that resolve to a network URI"*, and **SHOULD** bound schema depth/subschema count against DoS. ([Base §JSON Schema Usage](https://modelcontextprotocol.io/specification/2026-07-28/basic/index))

**Recommendation shape (not a decision — that's the team's).** A modern-only hand-roll in the Hono data plane is a genuinely small piece of work — roughly a single module hanging off the existing `app.all('/p/:slug/*', …)` route — and it fits the repo's zero-new-dependency norm exactly. Two questions decide it:

1. *"Do we need to serve legacy-era clients on day one?"* If yes, take the SDK; dual-era is where the SDK's value is concentrated. If no, hand-roll. Per §B9 the clients that matter (Claude Code, VS Code, Cursor, Gemini CLI, OpenAI Responses API) are all actively maintained and tracking current SDKs, so "no" is defensible — but it is a bet on their upgrade cadence, which is not under our control.
2. *"Are we willing to move the workspace from `zod ^3.23.0` to `zod ^4.2.0`?"* `@modelcontextprotocol/server@2.x` requires it. If that migration is off the table for now, the SDK option is effectively off the table too, and hand-rolling is the only path — which is fine, because hand-rolling modern-only is small.

The honest one-line summary: **the wire protocol is now simple enough to hand-roll responsibly, and the SDK is now light enough to adopt responsibly. The deciding factors are legacy-client support and the zod major, not the JSON-RPC.**

---

## Sources

### MCP specification (revision 2026-07-28)

- [Specification index](https://modelcontextprotocol.io/specification/latest)
- [Key Changes (changelog vs 2025-11-25)](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [Base Protocol overview (statelessness, `_meta`, error codes, Auth)](https://modelcontextprotocol.io/specification/2026-07-28/basic/index)
- [Versioning and Compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
- [Transports overview](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)
- [Streamable HTTP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
- [stdio transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)
- [Multi Round-Trip Requests (MRTR)](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)
- [Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [Authorization Security Considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)
- [Server: Tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [Server: Discovery (`server/discover`)](https://modelcontextprotocol.io/specification/2026-07-28/server/discover)
- [Deprecated features registry](https://modelcontextprotocol.io/specification/2026-07-28/deprecated)
- [Security Best Practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)
- [Feature Lifecycle and Deprecation Policy](https://modelcontextprotocol.io/community/feature-lifecycle)
- [`schema/2026-07-28/schema.ts`](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2026-07-28/schema.ts) — fetched and inspected locally

### MCP blog (official)

- [The 2026-07-28 Specification](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [The 2026-07-28 MCP Specification Release Candidate](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
- [Tool Annotations as Risk Vocabulary: What Hints Can and Can't Do](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/)

### Client documentation (first-party)

- [Claude Code — MCP](https://code.claude.com/docs/en/mcp) · [MCP quickstart](https://code.claude.com/docs/en/mcp-quickstart) · [CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Claude custom connectors — remote MCP](https://claude.com/docs/connectors/custom/remote-mcp) · [connector authentication](https://claude.com/docs/connectors/building/authentication) · [Help Center: custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
- [OpenAI Responses API reference](https://developers.openai.com/api/docs/api-reference/responses/create) · [MCP & Connectors guide](https://developers.openai.com/api/docs/guides/tools-connectors-mcp) · [ChatGPT developer mode](https://developers.openai.com/api/docs/guides/developer-mode) · [Building MCP servers](https://developers.openai.com/api/docs/mcp)
- [VS Code — MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration) · [MCP servers](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)
- [Cursor — MCP](https://cursor.com/docs/mcp)
- [Gemini CLI — MCP servers](https://google-gemini.github.io/gemini-cli/docs/tools/mcp-server.html)
- [`mcp-remote`](https://github.com/geelen/mcp-remote)

### Community / non-normative (cited as such)

- [Discussion #2457 — Client-Side Tool Description Substitution as a Defense Against Indirect Prompt Injection in MCP](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/2457)

### Referenced RFCs and drafts

[OAuth 2.1 draft-13](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13) ·
[RFC 6750 Bearer Token Usage](https://datatracker.ietf.org/doc/html/rfc6750) ·
[RFC 7591 Dynamic Client Registration](https://datatracker.ietf.org/doc/html/rfc7591) ·
[RFC 8414 AS Metadata](https://datatracker.ietf.org/doc/html/rfc8414) ·
[RFC 8707 Resource Indicators](https://www.rfc-editor.org/rfc/rfc8707.html) ·
[RFC 9207 AS Issuer Identification](https://datatracker.ietf.org/doc/html/rfc9207) ·
[RFC 9728 Protected Resource Metadata](https://datatracker.ietf.org/doc/html/rfc9728) ·
[OAuth Client ID Metadata Documents draft-00](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00)

### Gateways and SDK (section D)

- [LiteLLM — MCP](https://docs.litellm.ai/docs/mcp) · [MCP access control](https://docs.litellm.ai/docs/mcp_control) · [`litellm/proxy/_experimental/mcp_server/server.py`](https://raw.githubusercontent.com/BerriAI/litellm/main/litellm/proxy/_experimental/mcp_server/server.py)
- [Portkey — MCP Gateway](https://portkey.ai/docs/product/mcp-gateway) · [using MCP servers](https://portkey.ai/docs/product/mcp-gateway/using-mcp-servers) · [MCP authentication](https://portkey.ai/docs/product/mcp-gateway/authentication)
- [Cloudflare — agents / MCP](https://developers.cloudflare.com/agents/model-context-protocol/) · [MCP authorization](https://developers.cloudflare.com/agents/model-context-protocol/authorization/) · [MCP Server Portals](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/)
- [Kong — `ai-mcp-proxy` plugin](https://developer.konghq.com/plugins/ai-mcp-proxy/) · [reference](https://developer.konghq.com/plugins/ai-mcp-proxy/reference/) · [Get started with MCP server](https://developer.konghq.com/ai-gateway/get-started-with-mcp-server/)
- [docker/mcp-gateway](https://github.com/docker/mcp-gateway) (MIT)
- [IBM/mcp-context-forge](https://github.com/IBM/mcp-context-forge) (Apache-2.0)
- [modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) · [`docs/protocol-versions.md`](https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/main/docs/protocol-versions.md)
- [npm registry: `@modelcontextprotocol/sdk`](https://registry.npmjs.org/@modelcontextprotocol/sdk) · [weekly downloads API](https://api.npmjs.org/downloads/point/last-week/@modelcontextprotocol/sdk)
- [MCP versioning guide](https://modelcontextprotocol.io/specification/versioning)

### Repository files referenced

- `packages/connectors/src/breed.ts:107` — the dormant `toMcp?(fence: C): unknown[]` hook
- `apps/data-plane/src/app.ts:223` — the existing `app.all('/p/:slug/*', …)` proxy route
- `package.json` / `apps/*/package.json` / `packages/*/package.json` — current `zod ^3.23.0` pin
