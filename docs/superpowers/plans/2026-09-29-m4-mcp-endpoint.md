# M4 — Per-paddock MCP endpoint over full OAuth 2.1

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. **Every subagent is top-tier: implementer/fixer = Opus; task reviewer and whole-branch reviewer = Opus. Never Haiku, never Sonnet. Pass `model:` explicitly on every dispatch.** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve `POST <DATA_PLANE_URL>/p/<slug>/mcp` as a stateless, dual-era MCP JSON-RPC endpoint (revision `2026-07-28`, plus legacy `2025-11-25` / `2025-06-18` clients) that accepts only OP-issued access tokens, obtained by a CIMD client after a `member`/`admin` approves it on a consent screen that mints an `oauth`-kind API key, with every `tools/call` running the proxy's own rate-limit → quota → `guard()` → handle/proxy → meter pipeline.

**Architecture:** The auth service (`apps/auth`, oidc-provider) enables Client ID Metadata Documents, resolves `<DATA_PLANE_URL>/p/<slug>/mcp` resource indicators dynamically, renders a consent screen, and on Approve calls a control-plane internal route with an OP-signed assertion; `keys-service.mintOauthKey` writes an `api_key` row of `kind='oauth'` bound to the grant, and the OP stamps that key's id into every MCP access token as `mm_kid`. The data plane verifies those tokens offline with a verifier extracted from the admin API into `@metamodels/schema/access-token`, resolves the key by id (`kind='oauth'` only), and dispatches `tools/call` through breed hooks `mcpCall` (plan a synthetic request) and `mcpResult` (shape MCP content) that feed the unchanged proxy gates. One endpoint serves both eras: an `initialize` or a legacy `MCP-Protocol-Version` with no `_meta` version selects legacy result shapes. Everything else is held to the 2026-07-28 header and version rules. OAuth, the gates and metering are the same code in both eras.

**Tech Stack:** TypeScript (ESM), pnpm workspace, Node 24, `oidc-provider@~9.12.2` (auth), Next.js 16 App Router Route Handlers (control plane), Hono 4 (data plane), `jose@^6.2.12` (already in the lockfile), drizzle-orm + drizzle-kit, Postgres (PGlite in tests), vitest, Playwright.

**Spec:** [`docs/superpowers/specs/2026-09-29-m4-mcp-endpoint-design.md`](../specs/2026-09-29-m4-mcp-endpoint-design.md) — read all of it before starting, especially §3 (decisions D0–D8), §4 (the endpoint) and §7 (the verification table). Parent design: [`2026-09-06-remote-control-surface-design.md`](../specs/2026-09-06-remote-control-surface-design.md). Binding input: the *"Handoff to M2 and M4"* section of [`2026-09-15-m1-auth-foundation.md`](2026-09-15-m1-auth-foundation.md). The rulings of 2026-09-29 that amend the spec are listed at the end under **Rulings folded into the spec (2026-09-29)**. They include D9 (dual-era), and they bind wherever the spec text still differs.

## Global Constraints

- **Node ≥ 24, pnpm workspace, TypeScript.** Before any command: `export PATH=/home/carmelo/.nvm/versions/node/v24.18.0/bin:$PATH`.
- **Zero new npm packages.** `jose` (already in the lockfile at `^6.2.12`, resolved `6.2.12`) becomes a dependency of `@metamodels/schema`; the task that edits that `package.json` (Task 2) runs `/powerup:supply-chain` first and records the result. `oidc-provider` stays pinned `~9.12.2`.
- **No MCP SDK.** JSON-RPC is implemented by hand: the modern methods (`server/discover`, `tools/list`, `tools/call`) and the legacy ones (`initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`).
- **MCP wire format follows the primary sources, not memory:** the 2026-07-28 schema (`schema/2026-07-28/schema.ts`) and its streamable-http, versioning, server/discover and caching pages, and the 2025-11-25 lifecycle, transports and tools pages. Task 12 lists what each one fixed. No `Mcp-Session-Id` is ever minted, in either era.
- **Every mutation keeps its audit entry and org scoping and goes through the control-plane services** (`keys-service`, `users-service`), never straight to SQL. **The auth service only READS `paddock`, `api_key`, `key_paddock` and `user`.**
- **`mutate`-class routes are permanently unexposable:** never listed as tools, never planned by `mcpCall`, refused by `guard()`.
- **`/p/<slug>/mcp` accepts only OP-issued access tokens; `mm_live_` keys never open MCP; OAuth tokens never open the proxy.**
- **One MCP resource per paddock, `<DATA_PLANE_URL>/p/<slug>/mcp`, built only by `mcpResource()` / parsed only by `parseMcpResource()`** from `@metamodels/schema`. MCP access tokens live 15 minutes. Refresh tokens reuse M2's rotation policy; a CIMD client bound to an MCP resource gets one without `offline_access` and not bound to the OP session (ruling R4, Task 6). Every other client keeps oidc-provider's defaults.
- **CIMD acknowledged as `draft-02`;** CIMD is on only when `OIDC_ISSUER` is https or loopback http, and only when oidc-provider's SSRF guard is installed.
- **No hardcoded personal LAN IP** anywhere in shipped code, tests or docs. No `metamodels.cc` in shipped runtime code. Every URL is configuration.
- **Test lanes that must stay green after every task:** root `pnpm test`, and the control-plane lane `pnpm --filter @metamodels/control-plane exec vitest run --testTimeout=30000`. Type-checking means `pnpm --filter @metamodels/control-plane build && pnpm -w exec tsc -b` (CI's order: the Next build produces `.next/types`).
- **The OpenAPI document is generated:** any change to `apps/control-plane/src/server/openapi.ts` is followed by `pnpm --filter @metamodels/control-plane gen:openapi` and the regenerated `docs/api/openapi.json` is committed in the same commit.
- **Docker verification only on a throwaway compose project** with explicit `-p mm-verify` and non-default host ports, checked free with `ss -ltnp` first. Never touch compose project `metamodels` (ports 3200/8787/3100) or its data. Throwaway slugs (`e2e-mcp-*-<run id>`), cleaned up. `down -v` only ever with `-p mm-verify`.
- **Commits** are authored `Carmelo Santana <me@carmelosantana.com>` (check `git config user.email` once before the first commit), conventional-commit subjects, **no attribution or co-author lines**. `main` needs linear history: work on the branch, land by PR.
- **Out of scope** (spec §6): SSE, server-initiated requests, `resources/*`, `prompts/*`, tool-list pagination, DCR, a CIMD allowlist, console UI for OP grants, public exposure by default.

## File map

| File | Responsibility |
|---|---|
| `packages/schema/src/schema.ts`, `drizzle/0009_oauth_keys.sql` | `api_key.kind`, `grant_id`, `oauth_client_id`, `user_id` and their CHECKs |
| `packages/schema/src/enums.ts` | `KEY_KINDS`, `PADDOCK_SLUG_RE` |
| `packages/schema/src/oidc.ts` | `mcpResource`, `parseMcpResource`, `MCP_SCOPE`, `CONSENT_ASSERTION_TYP`, `internalApiAudience`, `protectedResourceMetadataUrl`, `protectedResourceMetadata`, `requireOrigin` |
| `packages/schema/src/access-token.ts` | The offline RFC 9068 verifier core (D6): `createAccessTokenVerifier`, `TokenError`, `KeySetUnavailableError` |
| `packages/schema/src/jws.ts` | `signJwtRs256` — node:crypto compact JWS, used by the OP's consent assertion and by tests |
| `apps/control-plane/src/server/admin-token.ts` | Becomes a thin caller of the shared verifier |
| `apps/control-plane/src/server/keys-service.ts` | `mintOauthKey`, `preflightOauthKey`, `revokeOauthKeysForUser`, kind on `listKeys` |
| `apps/control-plane/src/server/users-service.ts` | Revokes a user's oauth keys on deactivate / demote-to-viewer |
| `apps/control-plane/src/server/consent-assertion.ts`, `replay-guard.ts`, `internal-route.ts`, `data-plane-url.ts` | Verifying the OP's consent assertion; the `jti` replay guard; the bearer-only wrapper |
| `apps/control-plane/src/app/api/internal/v1/oauth-keys/{route.ts,preflight/route.ts}` | The internal mint and preflight routes (D7) |
| `apps/control-plane/src/app/.well-known/oauth-protected-resource/api/admin/route.ts` | RFC 9728 metadata for the admin API |
| `apps/auth/src/cimd.ts` | CIMD feature config, issuer gate, client policy, SSRF-guard check, fixture fetch |
| `apps/auth/src/paddocks.ts` | Read-only paddock and oauth-key lookups for the OP |
| `apps/auth/src/resources.ts` | Dynamic MCP resource resolution; `extraTokenClaims` → `mm_kid` |
| `apps/auth/src/consent-api.ts` | Signs the consent assertion; calls the control plane's internal routes |
| `apps/auth/src/interactions.ts`, `views.ts` | The consent screen and its Approve / Deny / Close handling |
| `apps/auth/src/cimd-csp.ts` | Per-response `form-action` widening for CIMD interactions (D5) |
| `packages/connectors/src/{breed.ts,mcp.ts}` | `mcpCall` / `mcpResult` hooks and MCP result types |
| `packages/connectors/src/ollama/mcp.ts`, `comfyui/mcp.ts` | Each breed's `mcpCall` / `mcpResult` |
| `apps/data-plane/src/config/*` | `resolveKeyById` (oauth only), `resolveKeyByHash` (live only), paddock `name` |
| `apps/data-plane/src/mcp/{auth.ts,jsonrpc.ts,protocol.ts,endpoint.ts,job-images.ts}`, `pipeline.ts` | OAuth verification; JSON-RPC; the dual-era rules (era dispatch, header and version validation); the endpoint; ComfyUI image bytes; the shared gate pipeline |
| `apps/data-plane/src/app.ts` | Gate pipeline factored so the proxy and MCP share it; MCP routes registered before the catch-all |
| `docker-compose*.yml`, `scripts/new-stack.sh`, `docs/DEPLOY.md`, `.env.example` | `DATA_PLANE_URL`, `CONTROL_PLANE_INTERNAL_URL`, `OIDC_INTERNAL_URL` wiring; "Remote MCP connectors" |
| `apps/e2e/specs/mcp.spec.ts`, `apps/e2e/specs/helpers/admin-cli.ts`, `apps/e2e/compose.mcp.yml`, `apps/e2e/fixtures/mcp-client.json` | The real MCP flow and the §7 negative-case table on a throwaway stack |

---

### Task 1: Schema — oauth key columns and the MCP resource helpers

Spec §3.1 (schema) and §3.2 (config, `mcpResource` / `parseMcpResource`). Every later task builds on these names, so they land first and alone.

**Files:**
- Modify: `packages/schema/src/schema.ts:101-111` (`apiKey`)
- Modify: `packages/schema/src/enums.ts`
- Modify: `packages/schema/src/oidc.ts`
- Create (generated): `packages/schema/drizzle/0009_oauth_keys.sql`, `packages/schema/drizzle/meta/0009_snapshot.json`; Modify (generated): `packages/schema/drizzle/meta/_journal.json`
- Modify: `apps/control-plane/src/lib/paddock-schema.ts:5-11`
- Test: `packages/schema/test/schema.test.ts`, `packages/schema/test/oidc.test.ts`

**Interfaces:**
- Produces (all exported from `@metamodels/schema`):
  - `apiKey.kind: text NOT NULL DEFAULT 'live'`, `apiKey.grantId: text | null`, `apiKey.oauthClientId: text | null`, `apiKey.userId: uuid | null` (FK `user.id` ON DELETE CASCADE); index `api_key_grant_id`.
  - `KEY_KINDS = ['live', 'oauth'] as const`; `type KeyKind = (typeof KEY_KINDS)[number]`.
  - `PADDOCK_SLUG_RE: RegExp` (`/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/`); `PADDOCK_SLUG_MAX = 64`.
  - `MCP_SCOPE = 'mcp'`; `CONSENT_ASSERTION_TYP = 'mm-consent+jwt'`.
  - `mcpResource(dataPlaneUrl: string, slug: string): string`
  - `parseMcpResource(dataPlaneUrl: string, uri: string): string | null`
  - `internalApiAudience(consoleUrl: string): string` → `${consoleUrl}/api/internal`
  - `protectedResourceMetadataUrl(resource: string): string` (RFC 9728 §3.1)
  - `requireOrigin(name: string, value: string | undefined): string` — throws `${name} is required` / `${name} must be an absolute http(s) URL` / `${name} must be an origin (no path, query or fragment)`.

- [ ] **Step 1: Write the failing schema tests**

Append to `packages/schema/test/schema.test.ts` (it already imports `schema`, `eq`, `freshMigratedDb`):

```ts
describe('api_key kinds (M4 D1)', () => {
  async function seeded() {
    const db = await freshMigratedDb()
    const [o] = await db.insert(schema.org).values({ name: 'o' }).returning()
    const [u] = await db.insert(schema.user).values({
      orgId: o.id, email: 'member@x.io', passwordHash: 'scrypt$aa$bb', role: 'member',
    }).returning()
    return { db, o, u }
  }
  const oauthKey = (orgId: string, userId: string | null, over: Record<string, unknown> = {}) => ({
    orgId, name: 'Client (MCP) · member@x.io', prefix: 'oauth', hash: `h-${crypto.randomUUID()}`,
    kind: 'oauth', grantId: 'grant-1', oauthClientId: 'https://client.example.test/cimd.json', userId,
    ...over,
  })

  test('an insert that names no kind is a live key with no OAuth binding', async () => {
    const { db, o } = await seeded()
    const [k] = await db.insert(schema.apiKey).values({
      orgId: o.id, name: 'k', prefix: 'mm_live_x', hash: 'h-live',
    }).returning()
    expect(k).toMatchObject({ kind: 'live', grantId: null, oauthClientId: null, userId: null })
  })

  test('an oauth key carries its grant, its client and its user', async () => {
    const { db, o, u } = await seeded()
    const [k] = await db.insert(schema.apiKey).values(oauthKey(o.id, u.id)).returning()
    expect(k).toMatchObject({
      kind: 'oauth', grantId: 'grant-1', oauthClientId: 'https://client.example.test/cimd.json', userId: u.id,
    })
  })

  test('an oauth key missing any one binding column is refused', async () => {
    const { db, o, u } = await seeded()
    for (const missing of ['grantId', 'oauthClientId', 'userId']) {
      await expect(db.insert(schema.apiKey).values(oauthKey(o.id, u.id, { [missing]: null })), missing)
        .rejects.toThrow()
    }
  })

  test('a live key carrying any binding column is refused', async () => {
    const { db, o, u } = await seeded()
    for (const [col, value] of [['grantId', 'g'], ['oauthClientId', 'https://c.test/x'], ['userId', u.id]] as const) {
      await expect(db.insert(schema.apiKey).values({
        orgId: o.id, name: 'k', prefix: 'mm_live_x', hash: `h-${col}`, [col]: value,
      }), col).rejects.toThrow()
    }
  })

  test('kind is live or oauth and nothing else', async () => {
    const { db, o, u } = await seeded()
    await expect(db.insert(schema.apiKey).values(oauthKey(o.id, u.id, { kind: 'session' }))).rejects.toThrow()
  })

  test('deleting the user deletes their oauth keys', async () => {
    const { db, o, u } = await seeded()
    await db.insert(schema.apiKey).values(oauthKey(o.id, u.id))
    await db.delete(schema.user).where(eq(schema.user.id, u.id))
    expect(await db.select().from(schema.apiKey).where(eq(schema.apiKey.orgId, o.id))).toEqual([])
  })
})
```

- [ ] **Step 2: Write the failing identifier tests**

In `packages/schema/test/oidc.test.ts`, replace the import line with:

```ts
import {
  adminApiResource, CLI_CLIENT_ID, CONSENT_ASSERTION_TYP, CONSOLE_CLIENT_ID, internalApiAudience, MCP_SCOPE,
  mcpResource, OPERATOR_SESSION_TTL_MS, parseMcpResource, protectedResourceMetadataUrl, requireOrigin,
} from '../src/oidc.js'
import { KEY_KINDS, PADDOCK_SLUG_RE } from '../src/enums.js'
```

and append:

```ts
describe('MCP resource indicators (M4 D2)', () => {
  const DP = 'https://dp.example.test'

  test('one resource per paddock: <DATA_PLANE_URL>/p/<slug>/mcp', () => {
    expect(mcpResource(DP, 'small')).toBe('https://dp.example.test/p/small/mcp')
  })

  test('parseMcpResource inverts mcpResource', () => {
    for (const slug of ['small', 'a', 'gpu-2', 'x'.repeat(64)]) {
      expect(parseMcpResource(DP, mcpResource(DP, slug))).toBe(slug)
    }
  })

  test('parseMcpResource refuses anything that is not exactly one paddock\'s MCP resource', () => {
    for (const uri of [
      'https://dp.example.test/p/small/mcp/',
      'https://dp.example.test/p/small/mcp?x=1',
      'https://dp.example.test/p/small/mcp#f',
      'https://dp.example.test/p//mcp',
      'https://dp.example.test/p/mcp',
      'https://dp.example.test/p/a/b/mcp',
      'https://dp.example.test/p/Small/mcp',
      'https://dp.example.test/p/-small/mcp',
      'https://dp.example.test/p/small',
      'https://other.example.test/p/small/mcp',
      'http://dp.example.test/p/small/mcp',
      `https://dp.example.test/p/${'x'.repeat(65)}/mcp`,
      'https://console.example.test/api/admin',
      '',
    ]) {
      expect(parseMcpResource(DP, uri), uri).toBeNull()
    }
  })

  test('the MCP scope and the consent assertion typ are stable strings', () => {
    expect(MCP_SCOPE).toBe('mcp')
    expect(CONSENT_ASSERTION_TYP).toBe('mm-consent+jwt')
  })

  test('the internal API audience is the console origin plus /api/internal', () => {
    expect(internalApiAudience('https://console.example.test')).toBe('https://console.example.test/api/internal')
  })

  test('RFC 9728 §3.1: the metadata URL puts the well-known segment before the resource path', () => {
    expect(protectedResourceMetadataUrl('https://dp.example.test/p/small/mcp'))
      .toBe('https://dp.example.test/.well-known/oauth-protected-resource/p/small/mcp')
    expect(protectedResourceMetadataUrl('https://console.example.test/api/admin'))
      .toBe('https://console.example.test/.well-known/oauth-protected-resource/api/admin')
    expect(protectedResourceMetadataUrl('https://dp.example.test'))
      .toBe('https://dp.example.test/.well-known/oauth-protected-resource')
  })

  test('key kinds and the paddock slug rule are exported once, for every service', () => {
    expect(KEY_KINDS).toEqual(['live', 'oauth'])
    expect(PADDOCK_SLUG_RE.test('gpu-2')).toBe(true)
    expect(PADDOCK_SLUG_RE.test('Gpu')).toBe(false)
  })
})

describe('requireOrigin', () => {
  test('returns the bare origin, trailing slash stripped', () => {
    expect(requireOrigin('X', 'https://a.test/')).toBe('https://a.test')
  })

  test('names the variable when it is missing or blank', () => {
    expect(() => requireOrigin('DATA_PLANE_URL', undefined)).toThrow('DATA_PLANE_URL is required')
    expect(() => requireOrigin('DATA_PLANE_URL', '  ')).toThrow('DATA_PLANE_URL is required')
  })

  test('refuses a path, a query, a fragment, a non-http scheme and a non-URL', () => {
    for (const v of ['https://a.test/x', 'https://a.test/?q', 'https://a.test/#f', 'ftp://a.test', 'not a url']) {
      expect(() => requireOrigin('X', v), v).toThrow(/^X must be/)
    }
  })
})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm exec vitest run packages/schema/test/schema.test.ts packages/schema/test/oidc.test.ts`
Expected: FAIL — `mcpResource is not a function` (and friends), and the `api_key kinds` cases fail on the missing `kind` column.

- [ ] **Step 4: Add the enums**

Append to `packages/schema/src/enums.ts`:

```ts
export const KEY_KINDS = ['live', 'oauth'] as const
export type KeyKind = (typeof KEY_KINDS)[number]

/**
 * A paddock's public `/p/:slug` handle: lowercase letters, digits and hyphens, no leading or trailing
 * hyphen, at most `PADDOCK_SLUG_MAX` characters. One definition: the console validates new slugs
 * with it, and `parseMcpResource` refuses a resource indicator whose slug a paddock could not have.
 */
export const PADDOCK_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/
export const PADDOCK_SLUG_MAX = 64
```

In `apps/control-plane/src/lib/paddock-schema.ts`, change the imports and the slug rule to use them:

```ts
import { z } from 'zod'
import { PADDOCK_SLUG_MAX, PADDOCK_SLUG_RE, PADDOCK_STATUS, PADDOCK_THEMES } from '@metamodels/schema'

// Public /p/:slug handle: lowercase letters, digits, hyphens; no leading/trailing hyphen.
const slug = z
  .string()
  .trim()
  .min(1)
  .max(PADDOCK_SLUG_MAX)
  .regex(PADDOCK_SLUG_RE, 'slug must be lowercase letters, digits, and hyphens')
```

- [ ] **Step 5: Add the identifiers**

Append to `packages/schema/src/oidc.ts`, and add `import { PADDOCK_SLUG_MAX, PADDOCK_SLUG_RE } from './enums.js'` at the top:

```ts
/** The one scope an MCP resource declares (M4 D2). */
export const MCP_SCOPE = 'mcp'

/**
 * The `typ` of the OP-signed assertion the auth service sends to the control plane's internal
 * oauth-keys route (M4 D7). Distinct from `at+jwt`, so an access token can never be replayed as an
 * assertion, nor an assertion as an access token.
 */
export const CONSENT_ASSERTION_TYP = 'mm-consent+jwt'

/**
 * A paddock's MCP resource indicator (RFC 8707), and therefore the `aud` of every MCP access token
 * for it. MCP clients send the URL they connect to as `resource`, so this IS the endpoint URL.
 * `dataPlaneUrl` is `DATA_PLANE_URL`: a bare origin, configured, never derived.
 */
export function mcpResource(dataPlaneUrl: string, slug: string): string {
  return `${dataPlaneUrl}/p/${slug}/mcp`
}

/**
 * The paddock slug an MCP resource indicator names, or null when `uri` is not exactly
 * `mcpResource(dataPlaneUrl, <a slug a paddock could have>)`. No normalisation: a trailing slash, a
 * query, another scheme or another host are all a different resource, and none is ours.
 */
export function parseMcpResource(dataPlaneUrl: string, uri: string): string | null {
  const prefix = `${dataPlaneUrl}/p/`
  const suffix = '/mcp'
  if (!uri.startsWith(prefix) || !uri.endsWith(suffix)) return null
  const slug = uri.slice(prefix.length, uri.length - suffix.length)
  return slug.length <= PADDOCK_SLUG_MAX && PADDOCK_SLUG_RE.test(slug) ? slug : null
}

/** The `aud` of the OP's consent assertion: the control plane's internal API (M4 D7). */
export function internalApiAudience(consoleUrl: string): string {
  return `${consoleUrl}/api/internal`
}

/**
 * RFC 9728 §3.1: a resource's metadata lives at its origin, with `/.well-known/oauth-protected-resource`
 * inserted before the resource's path. Both resource servers advertise it in their 401 challenges.
 */
export function protectedResourceMetadataUrl(resource: string): string {
  const u = new URL(resource)
  return `${u.origin}/.well-known/oauth-protected-resource${u.pathname === '/' ? '' : u.pathname}`
}

/**
 * An environment variable that must hold an absolute http(s) URL with no path, query or fragment;
 * returned as `URL.origin` (no trailing slash). The same rules as the auth service's `OIDC_ISSUER`
 * and `CONSOLE_URL`, for the settings M4 adds (`DATA_PLANE_URL`, `CONTROL_PLANE_INTERNAL_URL`).
 */
export function requireOrigin(name: string, value: string | undefined): string {
  const v = value?.trim()
  if (!v) throw new Error(`${name} is required`)
  let u: URL
  try {
    u = new URL(v)
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`${name} must be an absolute http(s) URL`)
  if (u.pathname !== '/' || u.search || u.hash) throw new Error(`${name} must be an origin (no path, query or fragment)`)
  return u.origin
}
```

- [ ] **Step 6: Add the columns and CHECKs**

In `packages/schema/src/schema.ts`, replace the `apiKey` table:

```ts
export const apiKey = pgTable('api_key', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  prefix: text('prefix').notNull(),
  hash: text('hash').notNull().unique(),
  status: text('status').notNull().default('active'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  overrides: jsonb('overrides'),
  /**
   * `live`: a consumer `mm_live_` key, presented to the proxy. `oauth`: minted when a user approves an
   * MCP client (M4 D1), bound to that OP grant and never presentable — its hash is of random bytes
   * nobody kept. The data plane resolves each kind through a different path, so neither can stand in
   * for the other.
   */
  kind: text('kind').notNull().default('live'),
  /** The OP grant an oauth key is bound to; the OP names the key in every token it issues under it. */
  grantId: text('grant_id'),
  /** The CIMD `client_id` (an https URL) that was approved. */
  oauthClientId: text('oauth_client_id'),
  /** Who approved it. Revoked with them: deactivation and demotion to viewer revoke their oauth keys. */
  userId: uuid('user_id').references(() => user.id, { onDelete: 'cascade' }),
  createdAt: createdAt(),
}, (t) => [
  check('api_key_kind', sql`${t.kind} IN ('live', 'oauth')`),
  check('api_key_oauth_binding', sql`(${t.kind} = 'oauth' AND ${t.grantId} IS NOT NULL AND ${t.oauthClientId} IS NOT NULL AND ${t.userId} IS NOT NULL) OR (${t.kind} = 'live' AND ${t.grantId} IS NULL AND ${t.oauthClientId} IS NULL AND ${t.userId} IS NULL)`),
  // The OP looks a key up by its grant on every MCP token it issues (`extraTokenClaims`).
  index('api_key_grant_id').on(t.grantId),
])
```

- [ ] **Step 7: Generate the migration**

Run: `pnpm --filter @metamodels/schema db:generate --name oauth_keys`
Expected: `packages/schema/drizzle/0009_oauth_keys.sql` created, plus `meta/0009_snapshot.json` and a new `_journal.json` entry. Open the SQL and check it holds exactly these statements (drizzle may order them differently):

```sql
ALTER TABLE "api_key" ADD COLUMN "kind" text DEFAULT 'live' NOT NULL;
ALTER TABLE "api_key" ADD COLUMN "grant_id" text;
ALTER TABLE "api_key" ADD COLUMN "oauth_client_id" text;
ALTER TABLE "api_key" ADD COLUMN "user_id" uuid;
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
CREATE INDEX "api_key_grant_id" ON "api_key" USING btree ("grant_id");
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_kind" CHECK ("api_key"."kind" IN ('live', 'oauth'));
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_oauth_binding" CHECK (...);
```

No `NOT VALID` is needed: every existing row takes the `'live'` default with three nulls, which satisfies both checks. Never hand-edit the generated files.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/schema/test/schema.test.ts packages/schema/test/oidc.test.ts packages/schema/test/client-safe.test.ts`
Expected: PASS.

- [ ] **Step 9: Run both lanes**

Run: `pnpm test && pnpm --filter @metamodels/control-plane exec vitest run --testTimeout=30000`
Expected: PASS (every PGlite suite migrates through 0009; the slug rule now comes from `@metamodels/schema`).

- [ ] **Step 10: Commit**

```bash
git add packages/schema/src packages/schema/drizzle packages/schema/test apps/control-plane/src/lib/paddock-schema.ts
git commit -m "feat(schema): api_key kind, grant, client and user columns, and the MCP resource helpers"
```

---

### Task 2: One offline verifier in `@metamodels/schema/access-token`

Spec §3.7 (D6). The admin API's RFC 9068 verifier moves into the shared package, with the audience as a parameter, so the data plane (Task 11) and the consent route (Task 4) use the same reasoning. `admin-token.ts` becomes a thin caller, and **every M2 test stays green unchanged** — that is this task's acceptance test. A node:crypto JWS signer lands beside it for the OP's consent assertion (Task 7) and for tests.

**Files:**
- Modify: `packages/schema/package.json`
- Modify: `pnpm-lock.yaml` (importer entry only; no new package)
- Create: `packages/schema/src/access-token.ts`
- Create: `packages/schema/src/jws.ts`
- Modify: `apps/control-plane/src/server/admin-token.ts`
- Test: `packages/schema/test/access-token.test.ts`, `packages/schema/test/jws.test.ts`

**Interfaces:**
- Produces (`@metamodels/schema/access-token`):
  - `createAccessTokenVerifier(opts: { issuer: string; jwksUrl: string; typ: string }): AccessTokenVerifier`
  - `type AccessTokenVerifier = (jwt: string, audience: string) => Promise<Record<string, unknown>>`
  - `class TokenError extends Error { reason: string }`, `class KeySetUnavailableError extends Error { reason: string; cooldownMiss: boolean }`
  - `AUDIENCE_MISMATCH = 'audience mismatch'` (the `reason` of an audience refusal)
  - `JWKS_CACHE_MAX_AGE_MS = 600_000`, `JWKS_COOLDOWN_MS = 30_000`
- Produces (`@metamodels/schema/jws`): `signJwtRs256(header: Record<string, unknown>, payload: Record<string, unknown>, key: KeyObject): string` — the header's `alg` is always forced to `RS256`.
- Keeps (`apps/control-plane/src/server/admin-token.ts`): `verifyAdminToken`, `actorFromToken`, `grantsFromScope`, `credentialOf`, `resetAdminJwks`, `AdminClaims`, and re-exports `TokenError`, `KeySetUnavailableError`, `JWKS_COOLDOWN_MS` so `problem.ts`, `admin-route.ts` and their tests import unchanged.

- [ ] **Step 1: Run the supply-chain check (house rule)**

Invoke the skill `powerup:supply-chain` (Skill tool, `skill: "powerup:supply-chain"`) for this change: *add `jose@^6.2.12` as a runtime dependency of `@metamodels/schema`; the lockfile already resolves `jose@6.2.12` for `apps/control-plane` (dependency) and `apps/auth` (devDependency), and `oidc-provider@9.12.2` depends on `jose ^6.2.10`.* Follow what it says. Write down its verdict, the resolved version and the absence of any new lockfile package; they go in this task's commit body (Step 10). If the skill blocks the change, stop and report — do not continue without it.

- [ ] **Step 2: Add the dependency and the subpaths**

In `packages/schema/package.json`, add `"jose": "^6.2.12"` to `dependencies`, and two subpaths to `exports`:

```json
  "exports": {
    ".": "./src/index.ts",
    "./access-token": "./src/access-token.ts",
    "./config": "./src/config.ts",
    "./graph": "./src/graph.ts",
    "./jws": "./src/jws.ts",
    "./sealed": "./src/sealed.ts",
    "./reseal": "./src/reseal.ts"
  },
```

Run: `pnpm install && git diff --stat pnpm-lock.yaml && git diff pnpm-lock.yaml | grep '^[+-]' | grep -v '^[+-][+-]'`
Expected: the only lockfile change is the `packages/schema` importer gaining `jose: specifier ^6.2.12, version 6.2.12`. No new `packages:` or `snapshots:` entry. If anything else changes, stop.

Neither module is re-exported from `src/index.ts`: the barrel is imported by client components through `@metamodels/schema`, and these two are server-only.

- [ ] **Step 3: Write the failing verifier tests**

Create `packages/schema/test/access-token.test.ts`:

```ts
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import {
  AUDIENCE_MISMATCH, createAccessTokenVerifier, KeySetUnavailableError, TokenError,
} from '../src/access-token.js'

const AUD = 'https://dp.example.test/p/small/mcp'
const SUB = '11111111-1111-4111-8111-111111111111'
let key: CryptoKey
let server: Server
let issuer: string
/** A port nothing listens on: bound, then released. */
let dead: string

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  key = pair.privateKey
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
  server = createServer((req, res) => {
    if (req.url === '/jwks') {
      res.writeHead(200, { 'content-type': 'application/jwk-set+json' }).end(JSON.stringify({ keys: [jwk] }))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const d = createServer()
  await new Promise<void>((r) => d.listen(0, '127.0.0.1', r))
  dead = `http://127.0.0.1:${(d.address() as AddressInfo).port}`
  await new Promise<void>((r) => d.close(() => r()))
})
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())) })

interface MintOptions { typ?: string; kid?: string; exp?: number | false; iss?: string }
function mint(claims: Record<string, unknown>, o: MintOptions = {}): Promise<string> {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: o.kid ?? 'k1', typ: o.typ ?? 'at+jwt' })
    .setIssuer(o.iss ?? issuer)
    .setSubject(SUB)
    .setIssuedAt()
    .setJti('j1')
  if (o.exp !== false) jwt.setExpirationTime(o.exp ?? '15m')
  return jwt.sign(key)
}
const verifier = (typ = 'at+jwt', jwksUrl = `${issuer}/jwks`) => createAccessTokenVerifier({ issuer, jwksUrl, typ })

describe('createAccessTokenVerifier', () => {
  test('returns the verified claims of a token bound to the audience, as a string or in an array', async () => {
    const verify = verifier()
    expect((await verify(await mint({ aud: AUD, mm_kid: 'key-1' }), AUD)).mm_kid).toBe('key-1')
    expect((await verify(await mint({ aud: [AUD] }), AUD)).sub).toBe(SUB)
  })

  test('another audience is a TokenError whose reason is AUDIENCE_MISMATCH', async () => {
    await expect(verifier()(await mint({ aud: 'https://dp.example.test/p/other/mcp' }), AUD))
      .rejects.toMatchObject({ name: 'TokenError', reason: AUDIENCE_MISMATCH })
  })

  test('typ is pinned per verifier: an access token is not an assertion, nor an assertion an access token', async () => {
    const accessToken = await mint({ aud: AUD })
    const assertion = await mint({ aud: AUD }, { typ: 'mm-consent+jwt' })
    await expect(verifier('mm-consent+jwt')(accessToken, AUD)).rejects.toBeInstanceOf(TokenError)
    await expect(verifier('at+jwt')(assertion, AUD)).rejects.toBeInstanceOf(TokenError)
    expect((await verifier('mm-consent+jwt')(assertion, AUD)).aud).toBe(AUD)
  })

  test('refuses a token with no exp, an expired one, and one from another issuer', async () => {
    const verify = verifier()
    await expect(verify(await mint({ aud: AUD }, { exp: false }), AUD)).rejects.toBeInstanceOf(TokenError)
    await expect(verify(await mint({ aud: AUD }, { exp: Math.floor(Date.now() / 1000) - 60 }), AUD))
      .rejects.toMatchObject({ reason: 'expired, judged before resolving the signing key' })
    await expect(verify(await mint({ aud: AUD }, { iss: 'https://evil.example.test' }), AUD))
      .rejects.toBeInstanceOf(TokenError)
  })

  test('an unreachable key set is KeySetUnavailableError, never a token defect', async () => {
    const err = await verifier('at+jwt', `${dead}/jwks`)(await mint({ aud: AUD }), AUD).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(KeySetUnavailableError)
    expect((err as KeySetUnavailableError).cooldownMiss).toBe(false)
  })

  test('a kid missing from a set fetched moments ago is a cooldown miss (503), not a 401', async () => {
    const verify = verifier()
    await verify(await mint({ aud: AUD }), AUD)
    await expect(verify(await mint({ aud: AUD }, { kid: 'k-new' }), AUD))
      .rejects.toMatchObject({ name: 'KeySetUnavailableError', cooldownMiss: true })
  })
})
```

Create `packages/schema/test/jws.test.ts`:

```ts
import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JWK } from 'jose'
import { signJwtRs256 } from '../src/jws.js'

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })

describe('signJwtRs256', () => {
  test('signs a compact RS256 JWS that jose verifies against the public key', async () => {
    const exp = Math.floor(Date.now() / 1000) + 30
    const jwt = signJwtRs256({ typ: 'mm-consent+jwt', kid: 'k1' }, { iss: 'https://op.test', aud: 'x', exp }, rsa.privateKey)
    expect(decodeProtectedHeader(jwt)).toEqual({ typ: 'mm-consent+jwt', kid: 'k1', alg: 'RS256' })
    const jwks = createLocalJWKSet({
      keys: [{ ...(rsa.publicKey.export({ format: 'jwk' }) as JWK), kid: 'k1', alg: 'RS256' }],
    })
    const { payload } = await jwtVerify(jwt, jwks, {
      issuer: 'https://op.test', audience: 'x', typ: 'mm-consent+jwt', algorithms: ['RS256'],
    })
    expect(payload.exp).toBe(exp)
  })

  test('a header cannot choose the algorithm', () => {
    const jwt = signJwtRs256({ alg: 'none' }, {}, rsa.privateKey)
    expect(decodeProtectedHeader(jwt).alg).toBe('RS256')
  })

  test('refuses a key that cannot sign RS256', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    expect(() => signJwtRs256({}, {}, ec.privateKey)).toThrow(/RSA private key/)
    expect(() => signJwtRs256({}, {}, rsa.publicKey)).toThrow(/RSA private key/)
  })
})
```

- [ ] **Step 4: Run them to verify they fail**

Run: `pnpm exec vitest run packages/schema/test/access-token.test.ts packages/schema/test/jws.test.ts`
Expected: FAIL — `Cannot find module '../src/access-token.js'` / `'../src/jws.js'`.

- [ ] **Step 5: Write the signer**

Create `packages/schema/src/jws.ts`:

```ts
import { sign, type KeyObject } from 'node:crypto'

const segment = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')

/**
 * A compact RS256 JWS (RFC 7515) over `payload`, with node:crypto only. RSASSA-PKCS1-v1_5 with SHA-256
 * is node's default padding for an RSA key, which is exactly RS256. `alg` is always `RS256`, whatever
 * `header` says, so a caller cannot sign a token that names another algorithm.
 */
export function signJwtRs256(header: Record<string, unknown>, payload: Record<string, unknown>, key: KeyObject): string {
  if (key.type !== 'private' || key.asymmetricKeyType !== 'rsa') {
    throw new TypeError('signJwtRs256 needs an RSA private key')
  }
  const input = `${segment({ ...header, alg: 'RS256' })}.${segment(payload)}`
  return `${input}.${sign('sha256', Buffer.from(input), key).toString('base64url')}`
}
```

- [ ] **Step 6: Move the verifier**

Create `packages/schema/src/access-token.ts`. The two error classes, `keySetFailure` and `expiredBeforeVerifying` move **verbatim** from `apps/control-plane/src/server/admin-token.ts` (keep every comment); only the `KeySetUnavailableError` message loses the word "admin". The audience check moves in with `audience` as a parameter.

```ts
import { createRemoteJWKSet, decodeJwt, errors as joseErrors, jwtVerify, type RemoteJWKSet } from 'jose'

/** Rotation window as OUR number, not jose's default (M2 spec §4.3). */
export const JWKS_CACHE_MAX_AGE_MS = 10 * 60 * 1000
/** Also the 503's `Retry-After`, and the rate limit of the cooldown-miss log line. */
export const JWKS_COOLDOWN_MS = 30 * 1000

/** The `reason` of a token whose `aud` is not the audience asked for. */
export const AUDIENCE_MISMATCH = 'audience mismatch'

/**
 * The presented token was judged and refused. The caller answers 401.
 *
 * `reason` and `cause` are for server-side logging ONLY and must never reach the client. `reason`
 * is NOT safe to echo: `'subject is not an active user'` separates a valid, correctly-signed token
 * for a deactivated account from a bad token, which is an account-enumeration oracle. Every
 * resource server answers every `TokenError` with one fixed 401 body for exactly this reason.
 */
export class TokenError extends Error {
  readonly reason: string
  constructor(reason: string, options?: { cause?: unknown }) {
    super(`invalid token: ${reason}`, options)
    this.name = 'TokenError'
    this.reason = reason
  }
}

/**
 * The token could not be judged against a current key set: the OP's key set could not be obtained,
 * or the token names a `kid` missing from a set fetched too recently for jose to refetch it.
 *
 * Distinct from `TokenError` on purpose: the token may be perfectly valid. The caller must answer
 * 503, not 401 — a client that "fixes" a 401 by refreshing would spend a refresh on a token that
 * may be fine (and, when the OP is down, hit the same unreachable OP), and an operator watching a
 * wave of 401s would never learn the OP was down. As with `TokenError`, `reason` and `cause` are for
 * server-side logging only.
 *
 * `cooldownMiss` is true for the second case. Anyone can cause it by sending a token with an unknown
 * `kid` while the set is cooling down, so its log line is rate-limited; a fetch failure is logged
 * every time.
 */
export class KeySetUnavailableError extends Error {
  readonly reason: string
  readonly cooldownMiss: boolean
  constructor(reason: string, options?: { cause?: unknown; cooldownMiss?: boolean }) {
    super(`access token key set unavailable: ${reason}`, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'KeySetUnavailableError'
    this.reason = reason
    this.cooldownMiss = options?.cooldownMiss ?? false
  }
}

/**
 * Why the *key set* could not be obtained, or `undefined` when this is a token defect. Deliberately
 * an allowlist: anything unrecognised stays a token rejection, which is the conservative answer, so
 * a jose release that adds an error class cannot turn a bad token into a 503. An unmatched `kid`
 * (`JWKSNoMatchingKey`) is not decided here: the verifier decides it before calling this.
 */
function keySetFailure(e: unknown): string | undefined {
  if (e instanceof joseErrors.JWKSTimeout) return 'timed out fetching the key set'
  if (e instanceof joseErrors.JWKSInvalid) return 'the published key set is malformed'
  if (e instanceof joseErrors.JOSEError) {
    // The base class itself is what jose throws for a non-200 or unparseable JWKS response; every
    // complaint about the token is one of its subclasses, and each carries its own code.
    return e.code === 'ERR_JOSE_GENERIC' ? 'the key set endpoint did not return a usable JWKS' : undefined
  }
  // Not a jose error at all — a fetch `TypeError`, a DNS failure, an unusable internal URL. Never
  // something the presented token could have caused.
  return 'the key set endpoint could not be reached'
}

/**
 * True when the token's `exp`, read WITHOUT verifying the token, is already past. jose resolves the
 * signing key before it checks `exp`, so without this an expired token whose key has since been
 * dropped from the key set is a `kid` miss, and inside the cooldown a miss is a 503. The rotation
 * procedure drops a key only after every token it signed has expired, so every such token takes
 * this path and gets the same 401 as an expired token with a known key.
 *
 * Rejection-only: an unverified claim can make this return true and the token be refused, never
 * make a token be accepted. Anything that is not a numeric `exp` in the past (no `exp`, a string
 * `exp`, a token that does not decode) returns false and is left to `jwtVerify`, which rejects it as
 * before. The comparison is jose's own (`lib/jwt_claims_set.js`): `now` in whole seconds, expired
 * when `exp <= now`. jose subtracts `clockTolerance` from `now`, and the verifier sets none.
 */
function expiredBeforeVerifying(jwt: string): boolean {
  let exp: unknown
  try {
    exp = decodeJwt(jwt).exp
  } catch {
    return false
  }
  return typeof exp === 'number' && exp <= Math.floor(Date.now() / 1000)
}

export type AccessTokenVerifier = (jwt: string, audience: string) => Promise<Record<string, unknown>>

/**
 * An offline RFC 9068-style verifier for one issuer, one JWKS and one `typ`. The returned function
 * checks the signature (RS256 only, `kid` resolved from the published set and never pinned), `iss`,
 * `typ`, a REQUIRED `exp` and the audience; it returns the verified claims and leaves every other
 * claim (`client_id`, `scope`, `mm_kid`…) to its caller.
 *
 * The key set is created here, once per verifier, and lives as long as the verifier does: callers
 * hold one verifier per process (and reset it in tests).
 */
export function createAccessTokenVerifier(opts: { issuer: string; jwksUrl: string; typ: string }): AccessTokenVerifier {
  const keySet: RemoteJWKSet = createRemoteJWKSet(new URL(opts.jwksUrl), {
    cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
    cooldownDuration: JWKS_COOLDOWN_MS,
  })

  return async (jwt, audience) => {
    // Before the key set is touched: no fetch, and no cooldown to turn this into a 503.
    if (expiredBeforeVerifying(jwt)) throw new TokenError('expired, judged before resolving the signing key')
    // Read BEFORE verifying: a fetch during the call restarts the cooldown. See the catch below.
    const wasCoolingDown = keySet.coolingDown
    let payload: Record<string, unknown>
    let header: Record<string, unknown>
    try {
      const res = await jwtVerify(jwt, keySet, {
        issuer: opts.issuer,
        algorithms: ['RS256'],
        typ: opts.typ,
        // RFC 9068 §2.2 makes `exp` REQUIRED, and jose only checks the claim when it is present. Without
        // this, a token minted without `exp` would verify forever: this path is offline, with no
        // introspection and no revocation, so nothing short of a key rotation could take it back.
        requiredClaims: ['exp'],
      })
      payload = res.payload as Record<string, unknown>
      header = res.protectedHeader as unknown as Record<string, unknown>
    } catch (e) {
      /**
       * No key in the set matches the token's `kid`. jose (`jwks/remote.js`) reloads the set at the
       * start of a call when it has none or it is older than `cacheMaxAge`, and on a miss reloads once
       * more only when the set is past `cooldownDuration`. So: not cooling down at the start → 401
       * (the set was loaded during this call and the `kid` is retired or forged); cooling down → 503
       * (the `kid` may belong to a signer the OP began publishing since). The races are described in
       * full in M2's `admin-token.ts` history (commit that introduced this comment's first version).
       */
      if (e instanceof joseErrors.JWKSNoMatchingKey) {
        if (wasCoolingDown) {
          throw new KeySetUnavailableError(
            'the token `kid` is not in a key set fetched too recently to refetch', { cause: e, cooldownMiss: true })
        }
        throw new TokenError('the token `kid` is not in a key set fetched during this verification', { cause: e })
      }
      const unavailable = keySetFailure(e)
      if (unavailable) throw new KeySetUnavailableError(unavailable, { cause: e })
      throw new TokenError('signature, issuer, typ or expiry rejected', { cause: e })
    }
    if (header.alg !== 'RS256') throw new TokenError('alg must be RS256')

    // RFC 9068 allows `aud` to be a string or an array; the OP mints a bare string. Accept both.
    const aud = payload.aud
    const ok = typeof aud === 'string' ? aud === audience : Array.isArray(aud) && aud.includes(audience)
    if (!ok) throw new TokenError(AUDIENCE_MISMATCH)
    return payload
  }
}
```

When moving the `JWKSNoMatchingKey` comment, copy M2's full text (the two races paragraph included) from `admin-token.ts:170-193` instead of the shortened version above if you prefer; the behaviour must be identical either way.

- [ ] **Step 7: Run the new tests to verify they pass**

Run: `pnpm exec vitest run packages/schema/test/access-token.test.ts packages/schema/test/jws.test.ts`
Expected: PASS.

- [ ] **Step 8: Make `admin-token.ts` a thin caller**

Replace `apps/control-plane/src/server/admin-token.ts` entirely:

```ts
import { adminApiResource, CAPABILITIES, CLI_CLIENT_ID, type Capability } from '@metamodels/schema'
import {
  AUDIENCE_MISMATCH, createAccessTokenVerifier, JWKS_COOLDOWN_MS, KeySetUnavailableError, TokenError,
  type AccessTokenVerifier,
} from '@metamodels/schema/access-token'
import { loadOidcClientConfig, onOrigin } from '../auth/oidc-client'
import type { Actor, Credential } from '../auth/authorize'
import { loadActiveActor } from './actor'
import type { Db } from './db'

// Re-exported so `problem.ts`, `admin-route.ts` and their tests keep importing from here: the class
// identity is the shared package's, so `instanceof` agrees wherever an error is caught.
export { JWKS_COOLDOWN_MS, KeySetUnavailableError, TokenError }

export interface AdminClaims {
  sub: string
  scope?: string
  client_id?: string
  jti?: string
}

const CAPABILITY_SET: ReadonlySet<string> = new Set(CAPABILITIES)

/**
 * Granted scopes as capabilities. ALWAYS a concrete set — an unscoped token must intersect to
 * nothing and be denied, not fall through C3's `?? true` into full role power (spec §2.3).
 */
export function grantsFromScope(scope: string | undefined): ReadonlySet<Capability> {
  const out = new Set<Capability>()
  for (const s of (scope ?? '').split(/\s+/)) {
    if (CAPABILITY_SET.has(s)) out.add(s as Capability)
  }
  return out
}

/** `audit_log.changed_by` for a bearer. Never returns `session`, which is the cookie path's value. */
export function credentialOf(claims: { client_id?: string; jti?: string }): Credential {
  return `token:${claims.client_id ?? 'unknown'}:${claims.jti ?? 'unknown'}`
}

let verifier: AccessTokenVerifier | undefined

/**
 * One process-wide verifier, and with it one remote key set: the published `${issuer}/jwks`
 * re-homed onto the internal hop with `onOrigin`, exactly as the console re-homes `jwks_uri`.
 */
function adminVerifier(cfg: { issuer: string; internalUrl: string }): AccessTokenVerifier {
  verifier ??= createAccessTokenVerifier({
    issuer: cfg.issuer,
    jwksUrl: onOrigin(`${cfg.issuer}/jwks`, cfg.internalUrl),
    typ: 'at+jwt',
  })
  return verifier
}

/** Drops the cached verifier and its key set. For tests, which point the internal hop at a throwaway JWKS. */
export function resetAdminJwks(): void {
  verifier = undefined
}

export async function verifyAdminToken(jwt: string): Promise<AdminClaims> {
  const cfg = loadOidcClientConfig()
  let payload: Record<string, unknown>
  try {
    payload = await adminVerifier(cfg)(jwt, adminApiResource(cfg.consoleUrl))
  } catch (e) {
    // The shared verifier names no resource in its reason; this API's logs always have.
    if (e instanceof TokenError && e.reason === AUDIENCE_MISMATCH) {
      throw new TokenError('audience is not the admin API resource', { cause: e })
    }
    throw e
  }

  // Spec A15: only the CLI, whose device flow asks for the password every time (A4), may hold an
  // admin-API token. The OP issues it to no other client (`resourcesByClient`); this is the second
  // lock, so a client M4 admits (a CIMD client) and lists there by mistake still gets nothing here.
  if (payload.client_id !== CLI_CLIENT_ID) throw new TokenError('client_id is not the admin CLI')

  const sub = payload.sub
  if (typeof sub !== 'string' || !sub) throw new TokenError('missing sub')
  return {
    sub,
    scope: typeof payload.scope === 'string' ? payload.scope : undefined,
    client_id: CLI_CLIENT_ID,
    jti: typeof payload.jti === 'string' ? payload.jti : undefined,
  }
}

/** Token → Actor. The user row is re-read, so deactivation takes effect immediately, as on the cookie path. */
export async function actorFromToken(db: Db, jwt: string): Promise<Actor> {
  const claims = await verifyAdminToken(jwt)
  const actor = await loadActiveActor(db, claims.sub, credentialOf(claims))
  if (!actor) throw new TokenError('subject is not an active user')
  return { ...actor, grants: grantsFromScope(claims.scope) }
}
```

- [ ] **Step 9: Prove M2's tests pass unchanged**

Run: `git diff --stat -- 'apps/control-plane/src/**/*.test.ts' && pnpm --filter @metamodels/control-plane exec vitest run --testTimeout=30000 src/server/admin-token.test.ts src/server/problem.test.ts src/server/admin-route.test.ts`
Expected: the `git diff` prints nothing (no test file touched), and all three suites PASS — including the cooldown, rotation, unreachable-OP and `audience is not the admin API resource` cases.

Then the full lanes and the typecheck:

Run: `pnpm test && pnpm --filter @metamodels/control-plane exec vitest run --testTimeout=30000 && pnpm --filter @metamodels/control-plane build && pnpm -w exec tsc -b`
Expected: PASS, and the build and `tsc -b` are clean.

- [ ] **Step 10: Commit**

```bash
git add packages/schema/package.json pnpm-lock.yaml packages/schema/src/access-token.ts packages/schema/src/jws.ts packages/schema/test/access-token.test.ts packages/schema/test/jws.test.ts apps/control-plane/src/server/admin-token.ts
git commit -m "refactor(schema): share the offline access-token verifier as @metamodels/schema/access-token" -m "Supply-chain: <paste the /powerup:supply-chain verdict>. jose@6.2.12 was already resolved in pnpm-lock.yaml; this adds only the packages/schema importer entry, no new package."
```

---

### Task 3: `keys-service` mints oauth keys; users lose them with their approval rights

Spec §3.1 (D1) and §3.3 (D3). The control plane stays the only writer of keys: minting, rebinding and revoking oauth keys all happen here, with org scoping, the per-org lock and one audit row each. The Keys page and the admin API's listing show each key's kind and client.

**Files:**
- Modify: `apps/control-plane/src/auth/authorize.ts:13-15` (`Credential`)
- Modify: `apps/control-plane/src/server/keys-service.ts`
- Modify: `apps/control-plane/src/server/users-service.ts:57-107`
- Modify: `apps/control-plane/src/app/(app)/team/actions.ts`
- Modify: `apps/control-plane/src/app/(app)/keys/page.tsx`, `apps/control-plane/src/app/(app)/keys/keys-client.tsx`
- Modify: `apps/control-plane/src/server/openapi.ts:671-690` (`KeySummary`); regenerate `docs/api/openapi.json`
- Test: `apps/control-plane/src/server/keys-service.test.ts`, `apps/control-plane/src/server/users-service.test.ts`, `apps/control-plane/src/server/openapi.test.ts`

**Interfaces:**
- Consumes: `apiKey.kind/grantId/oauthClientId/userId`, `KEY_KINDS` (Task 1).
- Produces:
  - `type Credential = 'session' | \`token:${string}:${string}\` | \`consent:${string}:${string}\``
  - `interface KeyRow { …; kind: string; oauthClientId: string | null }`
  - `OAUTH_KEY_PREFIX = 'oauth'`; `oauthKeyName(clientName: string, email: string): string` (≤ 120 chars)
  - `interface MintOauthKeyInput { clientId: string; clientName: string; paddockSlug: string; grantId: string }`
  - `interface MintedOauthKey { keyId: string; outcome: 'created' | 'rebound' }`
  - `mintOauthKey(db: Db, actor: Actor, input: MintOauthKeyInput): Promise<MintedOauthKey>` — `resource.write`; `NotFoundError` for an unknown, disabled or foreign paddock.
  - `type OauthPreflight = { allowed: true; reason: null } | { allowed: false; reason: string }`
  - `preflightOauthKey(db: Db, actor: Actor, paddockSlug: string | null): Promise<OauthPreflight>` — read-only.
  - `PREFLIGHT_NO_CAPABILITY`, `PREFLIGHT_NO_PADDOCK` (the two refusal strings)
  - `revokeOauthKeysForUser(tx: Db, actor: Actor, userId: string, reason: 'user.deactivate' | 'user.role'): Promise<number>` — call only inside a `users-service` transaction.

- [ ] **Step 1: Write the failing keys-service tests**

In `apps/control-plane/src/server/keys-service.test.ts`, extend the service import:

```ts
import {
  listKeys, createKey, revokeKey, NotFoundError, mintOauthKey, preflightOauthKey, oauthKeyName,
  OAUTH_KEY_PREFIX, PREFLIGHT_NO_CAPABILITY, PREFLIGHT_NO_PADDOCK,
} from './keys-service'
```

and append:

```ts
const CLIENT = 'https://client.example.test/cimd.json'

/** A real user row: an oauth key's `user_id` is a foreign key, so the actor must exist. */
async function userIn(db: TestDb, orgId: string, role: Actor['role'] = 'member'): Promise<Actor> {
  const email = `${role}-${crypto.randomUUID()}@x.io`
  const [u] = await db.insert(schema.user).values({ orgId, email, passwordHash: 'scrypt$x$y', role }).returning()
  return { id: u.id, orgId, email, role, credential: `consent:${CLIENT}:grant-1` }
}

const mintInput = (over: Partial<Parameters<typeof mintOauthKey>[2]> = {}) => ({
  clientId: CLIENT, clientName: 'Claude', paddockSlug: 'p1', grantId: 'grant-1', ...over,
})

describe('keys-service mintOauthKey (M4 D1)', () => {
  test('mints an unpresentable oauth key bound to the grant, the client, the user and one paddock', async () => {
    const db = testDb()
    const o = await seedOrg(db)
    const actor = await userIn(db, o.id)
    const pid = await paddockIn(db, o.id, 'p1')

    const minted = await mintOauthKey(db, actor, mintInput())
    expect(minted.outcome).toBe('created')
    // Nothing that could be presented comes back: no plaintext, no hash.
    expect(Object.keys(minted).sort()).toEqual(['keyId', 'outcome'])

    const [row] = await db.select().from(schema.apiKey).where(eq(schema.apiKey.id, minted.keyId))
    expect(row).toMatchObject({
      orgId: o.id, kind: 'oauth', status: 'active', prefix: OAUTH_KEY_PREFIX,
      grantId: 'grant-1', oauthClientId: CLIENT, userId: actor.id, expiresAt: null,
      name: `Claude (MCP) · ${actor.email}`,
    })
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/)

    const links = await db.select().from(schema.keyPaddock).where(eq(schema.keyPaddock.keyId, minted.keyId))
    expect(links.map((l) => l.paddockId)).toEqual([pid])

    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'key.create'))
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      target: `key:${minted.keyId}`, detail: { kind: 'oauth', client_id: CLIENT }, changedBy: actor.credential,
    })
  })

  test('the same user, client and paddock again rebinds the existing key to the new grant', async () => {
    const db = testDb()
    const o = await seedOrg(db)
    const actor = await userIn(db, o.id)
    await paddockIn(db, o.id, 'p1')
    const first = await mintOauthKey(db, actor, mintInput())
    const second = await mintOauthKey(db, actor, mintInput({ grantId: 'grant-2' }))

    expect(second).toEqual({ keyId: first.keyId, outcome: 'rebound' })
    const rows = await db.select().from(schema.apiKey)
    expect(rows).toHaveLength(1)
    expect(rows[0].grantId).toBe('grant-2')
    const rebinds = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'key.rebind'))
    expect(rebinds).toHaveLength(1)
    expect(rebinds[0]).toMatchObject({ target: `key:${first.keyId}`, detail: { kind: 'oauth', client_id: CLIENT } })
  })

  test('another paddock, another client or another user each get a key of their own', async () => {
    const db = testDb()
    const o = await seedOrg(db)
    const a = await userIn(db, o.id)
    const b = await userIn(db, o.id)
    await paddockIn(db, o.id, 'p1')
    await paddockIn(db, o.id, 'p2')
    const base = await mintOauthKey(db, a, mintInput())
    const others = [
      await mintOauthKey(db, a, mintInput({ paddockSlug: 'p2' })),
      await mintOauthKey(db, a, mintInput({ clientId: 'https://other.example.test/cimd.json' })),
      await mintOauthKey(db, b, mintInput()),
    ]
    for (const m of others) {
      expect(m.outcome).toBe('created')
      expect(m.keyId).not.toBe(base.keyId)
    }
    expect(await db.select().from(schema.apiKey)).toHaveLength(4)
  })

  test('a revoked key is never rebound: consent after a revoke mints a new one', async () => {
    const db = testDb()
    const o = await seedOrg(db)
    const actor = await userIn(db, o.id)
    await paddockIn(db, o.id, 'p1')
    const first = await mintOauthKey(db, actor, mintInput())
    await revokeKey(db, { ...actor, role: 'admin' }, first.keyId)
    const again = await mintOauthKey(db, actor, mintInput({ grantId: 'grant-2' }))
    expect(again.outcome).toBe('created')
    expect(again.keyId).not.toBe(first.keyId)
  })

  test('a viewer is refused before anything is written', async () => {
    const db = testDb()
    const o = await seedOrg(db)
    const viewer = await userIn(db, o.id, 'viewer')
    await paddockIn(db, o.id, 'p1')
    await expect(mintOauthKey(db, viewer, mintInput())).rejects.toThrow(ForbiddenError)
    expect(await db.select().from(schema.apiKey)).toHaveLength(0)
    expect(await db.select().from(schema.auditLog)).toHaveLength(0)
  })

  test('an unknown slug, a disabled paddock and another org\'s paddock are all NotFoundError', async () => {
    const db = testDb()
    const o = await seedOrg(db)
    const actor = await userIn(db, o.id)
    const disabled = await paddockIn(db, o.id, 'off')
    await db.update(schema.paddock).set({ status: 'disabled' }).where(eq(schema.paddock.id, disabled))
    const [other] = await db.insert(schema.org).values({ name: 'other' }).returning()
    await paddockIn(db, other.id, 'theirs')
    for (const paddockSlug of ['nope', 'off', 'theirs']) {
      await expect(mintOauthKey(db, actor, mintInput({ paddockSlug })), paddockSlug).rejects.toThrow(NotFoundError)
    }
    expect(await db.select().from(schema.apiKey)).toHaveLength(0)
  })

  test('the key name is "<client> (MCP) · <email>", cut at 120 characters', () => {
    expect(oauthKeyName('Claude', 'a@b.io')).toBe('Claude (MCP) · a@b.io')
    expect(oauthKeyName('x'.repeat(200), 'a@b.io')).toHaveLength(120)
  })
})

describe('keys-service preflightOauthKey (M4 D3)', () => {
  test('a member of the paddock\'s org may approve; nothing is written', async () => {
    const db = testDb()
    const o = await seedOrg(db)
    const actor = await userIn(db, o.id)
    await paddockIn(db, o.id, 'p1')
    expect(await preflightOauthKey(db, actor, 'p1')).toEqual({ allowed: true, reason: null })
    expect(await db.select().from(schema.apiKey)).toHaveLength(0)
    expect(await db.select().from(schema.auditLog)).toHaveLength(0)
  })

  test('a viewer is told why, before any button is shown', async () => {
    const db = testDb()
    const o = await seedOrg(db)
    await paddockIn(db, o.id, 'p1')
    expect(await preflightOauthKey(db, await userIn(db, o.id, 'viewer'), 'p1'))
      .toEqual({ allowed: false, reason: PREFLIGHT_NO_CAPABILITY })
  })

  test('an unknown, disabled or foreign paddock, or no slug at all, is one refusal', async () => {
    const db = testDb()
    const o = await seedOrg(db)
    const actor = await userIn(db, o.id)
    const off = await paddockIn(db, o.id, 'off')
    await db.update(schema.paddock).set({ status: 'disabled' }).where(eq(schema.paddock.id, off))
    const [other] = await db.insert(schema.org).values({ name: 'other' }).returning()
    await paddockIn(db, other.id, 'theirs')
    for (const slug of ['nope', 'off', 'theirs', null]) {
      expect(await preflightOauthKey(db, actor, slug), String(slug)).toEqual({ allowed: false, reason: PREFLIGHT_NO_PADDOCK })
    }
  })
})

describe('keys-service listKeys shows each key\'s kind and client', () => {
  test('a live key and an oauth key side by side', async () => {
    const db = testDb()
    const o = await seedOrg(db)
    const actor = await userIn(db, o.id, 'admin')
    const pid = await paddockIn(db, o.id, 'p1')
    await createKey(db, actor, { name: 'ci', paddockIds: [pid] })
    await mintOauthKey(db, actor, mintInput())
    const rows = await listKeys(db, actor)
    expect(rows.map((r) => [r.kind, r.oauthClientId]).sort()).toEqual([['live', null], ['oauth', CLIENT]])
  })
})
```

- [ ] **Step 2: Write the failing users-service tests**

Append to `apps/control-plane/src/server/users-service.test.ts`:

```ts
describe('users-service revokes a user\'s oauth keys when they lose approval rights (M4 D3)', () => {
  async function oauthKeyFor(db: TestDb, orgId: string, userId: string): Promise<string> {
    const [f] = await db.insert(schema.flock).values({ orgId, breed: 'ollama', name: 'f', baseUrl: 'http://f' }).returning()
    const [p] = await db.insert(schema.paddock).values({ orgId, flockId: f.id, slug: `p-${crypto.randomUUID()}`, name: 'p' }).returning()
    const [k] = await db.insert(schema.apiKey).values({
      orgId, name: 'k', prefix: 'oauth', hash: crypto.randomUUID(), kind: 'oauth',
      grantId: 'g', oauthClientId: 'https://c.example.test/cimd.json', userId,
    }).returning()
    await db.insert(schema.keyPaddock).values({ keyId: k.id, paddockId: p.id })
    return k.id
  }
  const statusOf = async (db: TestDb, id: string) =>
    (await db.select({ s: schema.apiKey.status }).from(schema.apiKey).where(eq(schema.apiKey.id, id)))[0]?.s

  test('deactivating a user revokes each of their active oauth keys with one audit row, and nothing else', async () => {
    const db = testDb()
    const o = await seedOrg(db)
    const a = await seedUser(db, o.id, 'admin@x.io', 'admin')
    const m = await seedUser(db, o.id, 'm@x.io', 'member')
    const other = await seedUser(db, o.id, 'other@x.io', 'member')
    const k1 = await oauthKeyFor(db, o.id, m.id)
    const k2 = await oauthKeyFor(db, o.id, m.id)
    const theirs = await oauthKeyFor(db, o.id, other.id)
    const [live] = await db.insert(schema.apiKey).values({ orgId: o.id, name: 'live', prefix: 'mm_live_x', hash: 'h-live' }).returning()

    await setUserStatus(db, actor(a), m.id, 'deactivated', 5, NOW)

    expect(await statusOf(db, k1)).toBe('revoked')
    expect(await statusOf(db, k2)).toBe('revoked')
    expect(await statusOf(db, theirs)).toBe('active')
    expect(await statusOf(db, live.id)).toBe('active')
    const revokes = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'key.revoke'))
    expect(revokes.map((r) => r.target).sort()).toEqual([`key:${k1}`, `key:${k2}`].sort())
    expect(revokes.every((r) => (r.detail as { reason?: string }).reason === 'user.deactivate')).toBe(true)
  })

  test('demotion to viewer revokes; demotion to member does not; reactivation restores nothing', async () => {
    const db = testDb()
    const o = await seedOrg(db)
    const a = await seedUser(db, o.id, 'admin@x.io', 'admin')
    const m = await seedUser(db, o.id, 'm@x.io', 'admin')
    const k = await oauthKeyFor(db, o.id, m.id)

    await changeUserRole(db, actor(a), m.id, 'member')
    expect(await statusOf(db, k)).toBe('active')

    await changeUserRole(db, actor(a), m.id, 'viewer')
    expect(await statusOf(db, k)).toBe('revoked')
    const [row] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'key.revoke'))
    expect(row).toMatchObject({ target: `key:${k}`, detail: { kind: 'oauth', reason: 'user.role' } })

    await changeUserRole(db, actor(a), m.id, 'member')
    expect(await statusOf(db, k)).toBe('revoked')
  })
})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm --filter @metamodels/control-plane exec vitest run --testTimeout=30000 src/server/keys-service.test.ts src/server/users-service.test.ts`
Expected: FAIL — `mintOauthKey is not a function`, and the users-service cases find the oauth keys still `active`.

- [ ] **Step 4: Add the consent credential form**

In `apps/control-plane/src/auth/authorize.ts`, replace the `Credential` type and its comment:

```ts
/**
 * Which credential performed a mutation, for `audit_log.changed_by`. A closed grammar, not `string`,
 * because this is an audit identity — an arbitrary string here is an audit row nobody can trust:
 * - `session`: the console cookie session;
 * - `token:<client_id>:<jti>`: an admin-API bearer access token;
 * - `consent:<client_id>:<grant_id>`: the OP reporting that a user approved an MCP client (M4 D7).
 */
export type Credential = 'session' | `token:${string}:${string}` | `consent:${string}:${string}`
```

- [ ] **Step 5: Implement the key operations**

In `apps/control-plane/src/server/keys-service.ts`:

Replace the imports and `KeyRow`:

```ts
import { randomBytes } from 'node:crypto'
import { and, asc, eq, gt, inArray } from 'drizzle-orm'
import { apiKey, generateApiKey, hashApiKey, keyPaddock, paddock } from '@metamodels/schema'
import type { Db } from './db'
import { authorize, requireCapability, type Actor } from '../auth/authorize'
import { writeAudit } from './audit'
import { NotFoundError } from './flocks-service'
import { createKeyInput } from '../lib/key-schema'
import { acquireOrgLock } from './org-lock'
import { decodeCursor, type PageOpts } from './page'

export { NotFoundError }

export interface KeyRow {
  id: string
  name: string
  prefix: string
  status: string
  expiresAt: Date | null
  createdAt: Date
  paddockSlugs: string[]
  /** `live` (an `mm_live_` key) or `oauth` (minted at MCP consent; see `mintOauthKey`). */
  kind: string
  /** The approved CIMD client for an oauth key; null for a live key. */
  oauthClientId: string | null
}
```

In `listKeys`, add the two columns to the key query's `select`:

```ts
    .select({
      id: apiKey.id, name: apiKey.name, prefix: apiKey.prefix,
      status: apiKey.status, expiresAt: apiKey.expiresAt, createdAt: apiKey.createdAt,
      kind: apiKey.kind, oauthClientId: apiKey.oauthClientId,
    })
```

Append to the file:

```ts
/** What an oauth key shows where an `mm_live_` key shows its prefix: it has no presentable secret. */
export const OAUTH_KEY_PREFIX = 'oauth'
const KEY_NAME_MAX = 120

/** `"<client_name> (MCP) · <user email>"`, cut at 120 characters (M4 D1). */
export function oauthKeyName(clientName: string, email: string): string {
  return `${clientName} (MCP) · ${email}`.slice(0, KEY_NAME_MAX)
}

export interface MintOauthKeyInput {
  /** The CIMD client_id: an https URL, validated by the OP. */
  clientId: string
  /** Self-asserted by the client's metadata document; used only in the key's name. */
  clientName: string
  paddockSlug: string
  /** The OP grant the key is bound to, and that the OP will name the key under. */
  grantId: string
}

export interface MintedOauthKey {
  keyId: string
  outcome: 'created' | 'rebound'
}

/**
 * The consent-time mint (M4 D1). An oauth key is an ordinary `api_key` row, so everything that
 * limits or bills a caller — rollups, jobs, the rate limiter, `key_paddock` scoping, the Keys page —
 * works for MCP callers unchanged. It has no owner-held secret: the hash is of 32 random bytes that
 * are discarded here, so there is nothing to present, log or show.
 *
 * Idempotent per (user, client, paddock), under the per-org lock: the paddock lives in
 * `key_paddock`, so no unique index can express this. A second consent rebinds the existing ACTIVE
 * key to the new grant (`key.rebind`) rather than minting another. A revoked key is never rebound —
 * revocation is the operator's decision and consent does not undo it.
 */
export async function mintOauthKey(db: Db, actor: Actor, input: MintOauthKeyInput): Promise<MintedOauthKey> {
  requireCapability(actor, 'resource.write')
  return db.transaction(async (tx) => {
    await acquireOrgLock(tx, actor.orgId)
    const [p] = await tx
      .select({ id: paddock.id })
      .from(paddock)
      .where(and(eq(paddock.orgId, actor.orgId), eq(paddock.slug, input.paddockSlug), eq(paddock.status, 'active')))
      .limit(1)
    if (!p) throw new NotFoundError(`paddock ${input.paddockSlug}`)

    const [existing] = await tx
      .select({ id: apiKey.id })
      .from(apiKey)
      .innerJoin(keyPaddock, eq(keyPaddock.keyId, apiKey.id))
      .where(and(
        eq(apiKey.orgId, actor.orgId), eq(apiKey.kind, 'oauth'), eq(apiKey.status, 'active'),
        eq(apiKey.userId, actor.id), eq(apiKey.oauthClientId, input.clientId), eq(keyPaddock.paddockId, p.id),
      ))
      .limit(1)
    if (existing) {
      await tx.update(apiKey).set({ grantId: input.grantId }).where(eq(apiKey.id, existing.id))
      await writeAudit(tx, actor, {
        action: 'key.rebind', target: `key:${existing.id}`, detail: { kind: 'oauth', client_id: input.clientId },
      })
      return { keyId: existing.id, outcome: 'rebound' }
    }

    const [created] = await tx
      .insert(apiKey)
      .values({
        orgId: actor.orgId,
        name: oauthKeyName(input.clientName, actor.email),
        prefix: OAUTH_KEY_PREFIX,
        hash: hashApiKey(randomBytes(32).toString('base64url')),
        status: 'active',
        kind: 'oauth',
        grantId: input.grantId,
        oauthClientId: input.clientId,
        userId: actor.id,
      })
      .returning({ id: apiKey.id })
    await tx.insert(keyPaddock).values({ keyId: created.id, paddockId: p.id })
    await writeAudit(tx, actor, {
      action: 'key.create', target: `key:${created.id}`, detail: { kind: 'oauth', client_id: input.clientId },
    })
    return { keyId: created.id, outcome: 'created' }
  })
}

export type OauthPreflight = { allowed: true; reason: null } | { allowed: false; reason: string }

export const PREFLIGHT_NO_CAPABILITY =
  'Your role cannot approve apps. Ask an admin or a member of your organization to connect this one.'
export const PREFLIGHT_NO_PADDOCK =
  'This paddock does not exist, is disabled, or is not in your organization.'

/**
 * Would `mintOauthKey` succeed for this actor and paddock? Read-only: the consent screen asks before
 * it renders an Approve button (M4 §3.3), so a viewer sees a plain refusal rather than a button that
 * fails. An unknown, disabled and foreign paddock share one answer, so the screen reveals nothing
 * about another org's paddocks.
 */
export async function preflightOauthKey(db: Db, actor: Actor, paddockSlug: string | null): Promise<OauthPreflight> {
  if (!authorize(actor, 'resource.write')) return { allowed: false, reason: PREFLIGHT_NO_CAPABILITY }
  if (paddockSlug === null) return { allowed: false, reason: PREFLIGHT_NO_PADDOCK }
  const [p] = await db
    .select({ id: paddock.id })
    .from(paddock)
    .where(and(eq(paddock.orgId, actor.orgId), eq(paddock.slug, paddockSlug), eq(paddock.status, 'active')))
    .limit(1)
  return p ? { allowed: true, reason: null } : { allowed: false, reason: PREFLIGHT_NO_PADDOCK }
}

/**
 * Revokes every active oauth key `userId` approved, with one `key.revoke` audit row each, and returns
 * how many. It checks no capability: call it only inside a `users-service` transaction that already
 * required `user.manage` and holds the org lock. This keeps D3 true after the fact — a user who can
 * no longer approve apps no longer has any approved.
 */
export async function revokeOauthKeysForUser(
  tx: Db, actor: Actor, userId: string, reason: 'user.deactivate' | 'user.role',
): Promise<number> {
  const revoked = await tx
    .update(apiKey)
    .set({ status: 'revoked' })
    .where(and(
      eq(apiKey.orgId, actor.orgId), eq(apiKey.userId, userId), eq(apiKey.kind, 'oauth'), eq(apiKey.status, 'active'),
    ))
    .returning({ id: apiKey.id })
  for (const k of revoked) {
    await writeAudit(tx, actor, { action: 'key.revoke', target: `key:${k.id}`, detail: { kind: 'oauth', reason } })
  }
  return revoked.length
}
```

- [ ] **Step 6: Revoke on deactivate and on demotion to viewer**

In `apps/control-plane/src/server/users-service.ts`, add `import { revokeOauthKeysForUser } from './keys-service'`, then:

In `changeUserRole`, after the `writeAudit` call and still inside the transaction:

```ts
    // D3 after the fact: a viewer cannot approve apps, so it keeps none it approved before.
    if (role === 'viewer') await revokeOauthKeysForUser(tx, actor, userId, 'user.role')
```

In `setUserStatus`, after the `writeAudit` call and still inside the transaction:

```ts
    if (status === 'deactivated') await revokeOauthKeysForUser(tx, actor, userId, 'user.deactivate')
```

- [ ] **Step 7: Publish the invalidation the revokes need**

The data plane caches keys; a revoked oauth key must stop working at the next invalidation. In `apps/control-plane/src/app/(app)/team/actions.ts`, add `import { publishConfigInvalidation } from '../../../server/config-publisher'` and:

- in `changeRoleAction`, after `await changeUserRole(...)`: `await publishConfigInvalidation('user.role')`
- in `setStatusAction`, after `await setUserStatus(...)`: `await publishConfigInvalidation(status === 'active' ? 'user.reactivate' : 'user.deactivate')`

(`publishConfigInvalidation` never throws; it is a no-op without `REDIS_URL`.)

- [ ] **Step 8: Show kind and client on the Keys page**

In `apps/control-plane/src/app/(app)/keys/page.tsx`, extend the mapped row:

```tsx
      keys={keys.map((k) => ({
        id: k.id, name: k.name, prefix: k.prefix, status: k.status,
        expiresAt: k.expiresAt ? k.expiresAt.toISOString() : null,
        paddockSlugs: k.paddockSlugs,
        kind: k.kind, oauthClientId: k.oauthClientId,
      }))}
```

In `apps/control-plane/src/app/(app)/keys/keys-client.tsx`, replace the `KeyRow` interface and add a helper below it:

```tsx
interface KeyRow {
  id: string; name: string; prefix: string; status: string
  expiresAt: string | null; paddockSlugs: string[]
  kind: string; oauthClientId: string | null
}

/** An oauth key has no prefix worth showing: the approved client's host identifies it instead. */
function identity(k: KeyRow): string {
  if (k.kind !== 'oauth' || !k.oauthClientId) return `${k.prefix}…`
  try { return new URL(k.oauthClientId).host } catch { return k.oauthClientId }
}
```

Replace the table's header array and the row's name/prefix cells, and widen the empty row:

```tsx
      <DataTable headers={['Name', 'Kind', 'Key / client', 'Paddocks', 'Status', 'Expires', '']}>
        {keys.map((k) => (
          <tr key={k.id} className="border-b border-[var(--color-divider)]">
            <td className="px-3 py-2 text-[var(--color-text)]">{k.name}</td>
            <td className="px-3 py-2 text-xs text-[var(--color-muted)]">{k.kind === 'oauth' ? 'MCP app' : 'API key'}</td>
            <td className="px-3 py-2 font-mono text-xs text-[var(--color-muted)]">{identity(k)}</td>
```

(the Paddocks, Status, Expires and Revoke cells stay as they are), and `colSpan={7}` on the "No keys yet" row. The Revoke button is unchanged and works for both kinds; there is still no control that reveals a secret.

- [ ] **Step 9: Document kind and client in the OpenAPI listing**

In `apps/control-plane/src/server/openapi.ts`, add `KEY_KINDS` to the `@metamodels/schema` import, and in `KeySummary.properties` after `paddockSlugs`:

```ts
      kind: {
        type: 'string',
        enum: [...KEY_KINDS],
        description:
          '`live`: an `mm_live_` key made with `POST /keys`. `oauth`: minted when a user approved an MCP ' +
          'client for one paddock; it has no secret anyone holds, and it opens only that paddock\'s MCP endpoint.',
      },
      oauthClientId: {
        type: ['string', 'null'],
        description: 'For an `oauth` key, the approved client\'s Client ID Metadata Document URL; null otherwise.',
      },
```

and add `'kind', 'oauthClientId'` to `KeySummary.required`. In `apps/control-plane/src/server/openapi.test.ts`, add `KEY_KINDS` to its `@metamodels/schema` import and, in `'the shared enums are imported, not retyped'`, after the `KeySummary … status` line:

```ts
    expect(doc.components.schemas.KeySummary?.properties?.kind?.enum).toEqual([...KEY_KINDS])
```

Run: `pnpm --filter @metamodels/control-plane gen:openapi && git diff --stat docs/api/openapi.json`
Expected: `docs/api/openapi.json` changes (the two new `KeySummary` properties).

- [ ] **Step 10: Run the lanes and the typecheck**

Run: `pnpm --filter @metamodels/control-plane exec vitest run --testTimeout=30000 && pnpm test && pnpm --filter @metamodels/control-plane build && pnpm -w exec tsc -b`
Expected: PASS; build and `tsc -b` clean (`apps/cli`'s OpenAPI-parity test reads the regenerated document).

- [ ] **Step 11: Commit**

```bash
git add apps/control-plane/src docs/api/openapi.json
git commit -m "feat(keys): mint, rebind and revoke oauth-kind keys through keys-service"
```

---

### Task 4: The internal oauth-keys routes, opened only by an OP-signed assertion

Spec §3.5 (D7). The OP asks the control plane to mint (or preflight) through `POST /api/internal/v1/oauth-keys` and `GET /api/internal/v1/oauth-keys/preflight`. The only credential is an assertion the OP signs with its current signing key: `typ: mm-consent+jwt`, `aud: <CONSOLE_URL>/api/internal`, a life of 60 s or less, a unique `jti` that is refused on replay. The route re-derives everything else.

**Files:**
- Create: `apps/control-plane/src/server/consent-assertion.ts`
- Create: `apps/control-plane/src/server/replay-guard.ts`
- Create: `apps/control-plane/src/server/internal-route.ts`
- Create: `apps/control-plane/src/server/data-plane-url.ts`
- Create: `apps/control-plane/src/app/api/internal/v1/oauth-keys/route.ts`
- Create: `apps/control-plane/src/app/api/internal/v1/oauth-keys/preflight/route.ts`
- Modify: `apps/control-plane/src/server/admin-route.ts:34-46` (export `bearerOf`, `hasSessionCookie`)
- Modify: `apps/control-plane/src/server/test-token.ts`
- Modify: `.env.example`
- Test: `apps/control-plane/src/server/internal-oauth-keys.test.ts`

**Interfaces:**
- Consumes: `createAccessTokenVerifier`, `TokenError`, `KeySetUnavailableError` (Task 2); `CONSENT_ASSERTION_TYP`, `internalApiAudience`, `parseMcpResource`, `requireOrigin` (Task 1); `mintOauthKey`, `preflightOauthKey`, `Credential` (Task 3).
- Produces:
  - HTTP: `POST /api/internal/v1/oauth-keys` → `200 { key_id }` | 400 (bearer + cookie) | 401 (bad/replayed assertion, inactive user) | 403 (no `resource.write`) | 404 (unknown/inactive/foreign paddock) | 503 (key set unavailable).
  - HTTP: `GET /api/internal/v1/oauth-keys/preflight` → `200 { allowed: boolean, reason: string | null }` | 400 | 401 | 503.
  - Assertion claims: `iss`, `aud`, `iat`, `exp` (≤ 60 s after `iat`), `jti`, `sub`, `client_id`, `client_name`, `resource`, and `grant_id` (required by the mint; the preflight's assertion has none, because no grant exists yet).
  - `interface ConsentClaims { sub; clientId; clientName; resource; jti; exp; grantId? }`; `verifyConsentAssertion(jwt, { requireGrant }): Promise<ConsentClaims>`; `resetConsentVerifier(): void`; `MAX_ASSERTION_LIFETIME_S = 60`.
  - `interface ReplayGuard { claimOnce(jti: string, ttlSeconds: number): Promise<boolean> }`; `MemoryReplayGuard`; `RedisReplayGuard`; `replayGuard(): Promise<ReplayGuard>`; `setReplayGuardForTests(g: ReplayGuard | undefined): void`.
  - `loadDataPlaneUrl(): string` (reads `process.env.DATA_PLANE_URL`).
  - `TokenFixture.mintConsent(claims, opts?: { lifetimeSeconds?: number; typ?: string; aud?: string }): Promise<string>`; the fixture also sets `DATA_PLANE_URL=https://dp.test`.

- [ ] **Step 1: Extend the token fixture**

In `apps/control-plane/src/server/test-token.ts`:

- add `import { randomUUID } from 'node:crypto'` and `import { resetConsentVerifier } from './consent-assertion'`, and `internalApiAudience` to the `@metamodels/schema` import;
- change `ENV_KEYS` to `['OIDC_ISSUER', 'OIDC_INTERNAL_URL', 'CONSOLE_URL', 'CONSOLE_CLIENT_SECRET', 'DATA_PLANE_URL'] as const`;
- add to the `TokenFixture` interface:

```ts
  /** An OP consent assertion (M4 D7), signed by the same key the fixture publishes. */
  mintConsent(
    claims: Record<string, unknown>,
    opts?: { lifetimeSeconds?: number; typ?: string; aud?: string },
  ): Promise<string>
```

- after `process.env.CONSOLE_CLIENT_SECRET = …` add `process.env.DATA_PLANE_URL = 'https://dp.test'`, and call `resetConsentVerifier()` next to both `resetAdminJwks()` calls;
- add the method to the returned object:

```ts
    async mintConsent(claims, opts = {}) {
      const now = Math.floor(Date.now() / 1000)
      return new SignJWT({ client_name: 'Test MCP client', ...claims })
        .setProtectedHeader({ alg: 'RS256', kid, typ: opts.typ ?? 'mm-consent+jwt' })
        .setIssuer(issuer)
        .setAudience(opts.aud ?? internalApiAudience(consoleUrl))
        .setIssuedAt(now)
        .setExpirationTime(now + (opts.lifetimeSeconds ?? 30))
        .setJti(randomUUID())
        .sign(privateKey)
    },
```

- [ ] **Step 2: Write the failing route tests**

Create `apps/control-plane/src/server/internal-oauth-keys.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '@metamodels/schema'
import { adminApiResource, mcpResource } from '@metamodels/schema'
import { seedOrg, sharedDb } from '../test/db'
import { tokenFixture, type TokenFixture } from './test-token'
import { PREFLIGHT_NO_CAPABILITY, PREFLIGHT_NO_PADDOCK } from './keys-service'
import * as mintRoute from '../app/api/internal/v1/oauth-keys/route'
import * as preflightRoute from '../app/api/internal/v1/oauth-keys/preflight/route'

// Both route modules import `getDb` from this module id; the handlers resolve it per request.
const held = vi.hoisted(() => ({ db: undefined as unknown }))
vi.mock('./db', () => ({ getDb: () => held.db }))
const published = vi.hoisted(() => [] as string[])
vi.mock('./config-publisher', () => ({
  publishConfigInvalidation: async (reason: string) => { published.push(reason) },
}))

let tok: TokenFixture
beforeAll(async () => { tok = await tokenFixture() })
afterAll(async () => { await tok.close() })
beforeEach(() => { published.length = 0 })
const testDb = sharedDb()

const DP = 'https://dp.test'
const CLIENT = 'https://client.example.test/cimd.json'
const URL_MINT = 'https://console.test/api/internal/v1/oauth-keys'
const URL_PREFLIGHT = `${URL_MINT}/preflight`

/**
 * One org with the paddock `small`, and a way to add users to it. Paddock slugs are unique across the
 * whole table, so a case that needs several users adds them here rather than building a second world.
 */
async function world() {
  const db = testDb()
  held.db = db
  const o = await seedOrg(db)
  const [f] = await db.insert(schema.flock).values({ orgId: o.id, breed: 'ollama', name: 'f', baseUrl: 'http://f' }).returning()
  await db.insert(schema.paddock).values({ orgId: o.id, flockId: f.id, slug: 'small', name: 'Small' })
  const userIn = async (role = 'member', status = 'active') => (await db.insert(schema.user).values({
    orgId: o.id, email: `${role}-${status}@x.io`, passwordHash: 'scrypt$x$y', role, status,
  }).returning())[0]
  return { db, o, userIn }
}

const claims = (sub: string, over: Record<string, unknown> = {}) => ({
  sub, client_id: CLIENT, client_name: 'Claude', resource: mcpResource(DP, 'small'), grant_id: 'grant-1', ...over,
})
const bearer = (jwt: string) => ({ authorization: `Bearer ${jwt}` })
const mint = (headers: Record<string, string>) => mintRoute.POST(new Request(URL_MINT, { method: 'POST', headers }))
const preflight = (headers: Record<string, string>) => preflightRoute.GET(new Request(URL_PREFLIGHT, { headers }))

describe('POST /api/internal/v1/oauth-keys', () => {
  test('a member\'s approval mints an oauth key, audited as the consent, and invalidates the data plane', async () => {
    const { db, userIn } = await world()
    const u = await userIn()
    const res = await mint(bearer(await tok.mintConsent(claims(u.id))))
    expect(res.status).toBe(200)
    const { key_id } = await res.json() as { key_id: string }
    const [row] = await db.select().from(schema.apiKey).where(eq(schema.apiKey.id, key_id))
    expect(row).toMatchObject({ kind: 'oauth', grantId: 'grant-1', oauthClientId: CLIENT, userId: u.id })
    const [audit] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'key.create'))
    expect(audit.changedBy).toBe(`consent:${CLIENT}:grant-1`)
    expect(published).toEqual(['key.create'])
  })

  test('a second approval rebinds and says so to the data plane', async () => {
    const u = await (await world()).userIn()
    await mint(bearer(await tok.mintConsent(claims(u.id))))
    const res = await mint(bearer(await tok.mintConsent(claims(u.id, { grant_id: 'grant-2' }))))
    expect(res.status).toBe(200)
    expect(published).toEqual(['key.create', 'key.rebind'])
  })

  test('a replayed assertion is 401 and mints nothing more', async () => {
    const { db, userIn } = await world()
    const u = await userIn()
    const jwt = await tok.mintConsent(claims(u.id))
    expect((await mint(bearer(jwt))).status).toBe(200)
    expect((await mint(bearer(jwt))).status).toBe(401)
    expect(await db.select().from(schema.apiKey)).toHaveLength(1)
  })

  test('a viewer is 403, an unknown paddock and a non-MCP resource are 404', async () => {
    const { userIn } = await world()
    const viewer = await userIn('viewer')
    const member = await userIn('member')
    expect((await mint(bearer(await tok.mintConsent(claims(viewer.id))))).status).toBe(403)
    expect((await mint(bearer(await tok.mintConsent(claims(member.id, { resource: mcpResource(DP, 'nope') }))))).status).toBe(404)
    expect((await mint(bearer(await tok.mintConsent(claims(member.id, { resource: adminApiResource('https://console.test') }))))).status).toBe(404)
  })

  test('every bad assertion is the same 401: long-lived, wrong typ, wrong audience, no grant, inactive user', async () => {
    const { userIn } = await world()
    const u = await userIn()
    const bad = [
      await tok.mintConsent(claims(u.id), { lifetimeSeconds: 120 }),
      await tok.mintConsent(claims(u.id), { typ: 'at+jwt' }),
      await tok.mintConsent(claims(u.id), { aud: adminApiResource('https://console.test') }),
      await tok.mintConsent(claims(u.id, { grant_id: undefined })),
      await tok.mint({ sub: u.id }),
      'not-a-jwt',
    ]
    for (const jwt of bad) {
      const res = await mint(bearer(jwt))
      expect(res.status).toBe(401)
      expect(await res.json()).toMatchObject({ detail: 'the consent assertion was rejected' })
    }
    const off = await userIn('member', 'deactivated')
    expect((await mint(bearer(await tok.mintConsent(claims(off.id))))).status).toBe(401)
  })

  test('bearer-only, like the admin API: no bearer is 401, a bearer with a session cookie is 400', async () => {
    const u = await (await world()).userIn()
    expect((await mint({})).status).toBe(401)
    expect((await mint({ ...bearer(await tok.mintConsent(claims(u.id))), cookie: 'mm_session=x' })).status).toBe(400)
  })
})

describe('GET /api/internal/v1/oauth-keys/preflight', () => {
  test('answers allowed for a member, with no grant in the assertion and nothing written', async () => {
    const { db, userIn } = await world()
    const u = await userIn()
    const res = await preflight(bearer(await tok.mintConsent(claims(u.id, { grant_id: undefined }))))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ allowed: true, reason: null })
    expect(await db.select().from(schema.apiKey)).toHaveLength(0)
    expect(published).toEqual([])
  })

  test('answers a viewer, and an unknown paddock, with the reason the screen shows', async () => {
    const { userIn } = await world()
    const viewer = await userIn('viewer')
    const member = await userIn('member')
    expect(await (await preflight(bearer(await tok.mintConsent(claims(viewer.id))))).json())
      .toEqual({ allowed: false, reason: PREFLIGHT_NO_CAPABILITY })
    expect(await (await preflight(bearer(await tok.mintConsent(claims(member.id, { resource: mcpResource(DP, 'nope') }))))).json())
      .toEqual({ allowed: false, reason: PREFLIGHT_NO_PADDOCK })
  })

  test('refuses an access token presented as an assertion', async () => {
    const u = await (await world()).userIn()
    expect((await preflight(bearer(await tok.mint({ sub: u.id })))).status).toBe(401)
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @metamodels/control-plane exec vitest run --testTimeout=30000 src/server/internal-oauth-keys.test.ts`
Expected: FAIL — cannot resolve `../app/api/internal/v1/oauth-keys/route` (and `./consent-assertion` from the fixture).

- [ ] **Step 4: Document `DATA_PLANE_URL`**

The control plane is the first reader of `process.env.DATA_PLANE_URL` (the `.env.example` completeness test in `packages/schema/test/env-example.test.ts` fails without this). In `.env.example`, after `CONSOLE_URL=…`:

```bash
# Public URL of the data plane (the proxy and every paddock's MCP endpoint), origin only. MCP clients
# connect to <DATA_PLANE_URL>/p/<slug>/mcp and the sign-in service issues tokens for exactly that URL,
# so it must be what clients see. The port must match DATA_PLANE_PORT.
DATA_PLANE_URL=http://localhost:8787
```

- [ ] **Step 5: Implement the helpers**

Create `apps/control-plane/src/server/data-plane-url.ts`:

```ts
import { requireOrigin } from '@metamodels/schema'

/** `DATA_PLANE_URL`, validated as an origin. Read per call, as the rest of this server reads its config. */
export function loadDataPlaneUrl(): string {
  return requireOrigin('DATA_PLANE_URL', process.env.DATA_PLANE_URL)
}
```

Create `apps/control-plane/src/server/replay-guard.ts`:

```ts
/**
 * Refuses a consent assertion's `jti` the second time it is seen (M4 D7). The window only has to
 * outlast the assertion itself (60 s at most), so a short TTL is the whole mechanism.
 */
export interface ReplayGuard {
  /** True the first time `jti` is claimed within `ttlSeconds`, false on every later claim. */
  claimOnce(jti: string, ttlSeconds: number): Promise<boolean>
}

/** Redis `SET NX EX`: atomic across control-plane instances. */
export class RedisReplayGuard implements ReplayGuard {
  constructor(private readonly redis: { set(key: string, value: string, ex: 'EX', ttl: number, nx: 'NX'): Promise<string | null> }) {}
  async claimOnce(jti: string, ttlSeconds: number): Promise<boolean> {
    return (await this.redis.set(`mm:consent-jti:${jti}`, '1', 'EX', ttlSeconds, 'NX')) === 'OK'
  }
}

/**
 * One process's memory. Used only when `REDIS_URL` is unset (single-process development and tests);
 * every compose stack has Redis.
 */
export class MemoryReplayGuard implements ReplayGuard {
  private readonly seen = new Map<string, number>()
  async claimOnce(jti: string, ttlSeconds: number): Promise<boolean> {
    const now = Date.now()
    for (const [k, until] of this.seen) if (until <= now) this.seen.delete(k)
    if (this.seen.has(jti)) return false
    this.seen.set(jti, now + ttlSeconds * 1000)
    return true
  }
}

let singleton: ReplayGuard | undefined

export async function replayGuard(): Promise<ReplayGuard> {
  if (singleton) return singleton
  const url = process.env.REDIS_URL
  if (!url) {
    singleton = new MemoryReplayGuard()
    return singleton
  }
  const { default: Redis } = await import('ioredis')
  const client = new Redis(url)
  client.on('error', (e) => {
    // eslint-disable-next-line no-console
    console.error('[replay-guard] redis connection error:', e)
  })
  singleton = new RedisReplayGuard(client)
  return singleton
}

/** For tests: install a guard, or pass undefined to go back to the lazily built default. */
export function setReplayGuardForTests(g: ReplayGuard | undefined): void {
  singleton = g
}
```

Create `apps/control-plane/src/server/consent-assertion.ts`:

```ts
import { CONSENT_ASSERTION_TYP, internalApiAudience } from '@metamodels/schema'
import { createAccessTokenVerifier, TokenError, type AccessTokenVerifier } from '@metamodels/schema/access-token'
import { loadOidcClientConfig, onOrigin } from '../auth/oidc-client'

/** Spec §3.5: an assertion lives at most 60 s. The OP mints them with 30. */
export const MAX_ASSERTION_LIFETIME_S = 60

export interface ConsentClaims {
  /** The approving user's id. */
  sub: string
  clientId: string
  clientName: string
  /** The MCP resource indicator approved; the route parses the paddock slug from it. */
  resource: string
  jti: string
  exp: number
  /** The OP grant. Required by the mint; absent on a preflight, when no grant exists yet. */
  grantId?: string
}

let verifier: AccessTokenVerifier | undefined

export function resetConsentVerifier(): void {
  verifier = undefined
}

/**
 * The OP's consent assertion, verified with the shared verifier against the JWKS this server already
 * trusts, with `typ` and `aud` fixed. Nothing in it is trusted beyond "the OP says this user approved
 * this client for this resource under this grant": the route re-derives the user, the org, the
 * capability and the paddock from the database.
 */
export async function verifyConsentAssertion(jwt: string, opts: { requireGrant: boolean }): Promise<ConsentClaims> {
  const cfg = loadOidcClientConfig()
  verifier ??= createAccessTokenVerifier({
    issuer: cfg.issuer,
    jwksUrl: onOrigin(`${cfg.issuer}/jwks`, cfg.internalUrl),
    typ: CONSENT_ASSERTION_TYP,
  })
  const p = await verifier(jwt, internalApiAudience(cfg.consoleUrl))

  const { iat, exp } = p
  if (typeof iat !== 'number' || typeof exp !== 'number' || exp - iat > MAX_ASSERTION_LIFETIME_S) {
    throw new TokenError(`assertion lifetime is not within ${MAX_ASSERTION_LIFETIME_S} s`)
  }
  const str = (k: string): string | undefined => (typeof p[k] === 'string' && p[k] !== '' ? p[k] as string : undefined)
  const sub = str('sub')
  const clientId = str('client_id')
  const clientName = str('client_name')
  const resource = str('resource')
  const jti = str('jti')
  const grantId = str('grant_id')
  if (!sub || !clientId || !clientName || !resource || !jti) throw new TokenError('assertion is missing a claim')
  if (opts.requireGrant && !grantId) throw new TokenError('assertion names no grant')
  return { sub, clientId, clientName, resource, jti, exp, ...(grantId ? { grantId } : {}) }
}
```

In `apps/control-plane/src/server/admin-route.ts`, add `export` to `function bearerOf` and `function hasSessionCookie` (no other change).

Create `apps/control-plane/src/server/internal-route.ts`:

```ts
import { KeySetUnavailableError, TokenError } from '@metamodels/schema/access-token'
import type { Actor } from '../auth/authorize'
import { loadActiveActor } from './actor'
import { bearerOf, hasSessionCookie } from './admin-route'
import { verifyConsentAssertion, type ConsentClaims } from './consent-assertion'
import { getDb } from './db'
import { problem, problemForError } from './problem'
import { replayGuard } from './replay-guard'

/** Twice the longest assertion life: a `jti` is remembered for as long as it could still verify. */
export const REPLAY_WINDOW_SECONDS = 120

/** One body for every refused assertion, whatever the reason, like the admin API's fixed 401. */
function refused(): Response {
  return problem(401, 'Unauthorized', 'the consent assertion was rejected', undefined, { 'www-authenticate': 'Bearer' })
}

export interface InternalContext {
  claims: ConsentClaims
  actor: Actor
}

/**
 * The internal routes' wrapper (M4 D7). The M2 posture, unchanged: bearer only, and a request that
 * also carries a session cookie is refused on its shape. The bearer must be an OP-signed consent
 * assertion; its `jti` is claimed once; its subject must be an active user with a known role.
 * Not listed in the OpenAPI document and not under `/api/admin`.
 */
export function withConsentAssertion(
  handler: (ctx: InternalContext) => Promise<Response>,
  opts: { requireGrant: boolean },
) {
  return async (req: Request): Promise<Response> => {
    const bearer = bearerOf(req)
    if (bearer && hasSessionCookie(req)) {
      return problem(400, 'Bad Request', 'a request may present a bearer token or a session cookie, never both')
    }
    if (!bearer) return refused()

    let claims: ConsentClaims
    try {
      claims = await verifyConsentAssertion(bearer, opts)
    } catch (e) {
      if (e instanceof KeySetUnavailableError) return problemForError(e)
      if (e instanceof TokenError) {
        // eslint-disable-next-line no-console
        console.warn(`[internal] consent assertion refused: ${e.reason}`)
        return refused()
      }
      throw e
    }
    if (!(await (await replayGuard()).claimOnce(claims.jti, REPLAY_WINDOW_SECONDS))) {
      // eslint-disable-next-line no-console
      console.warn('[internal] consent assertion refused: jti replayed')
      return refused()
    }

    const actor = await loadActiveActor(getDb(), claims.sub, `consent:${claims.clientId}:${claims.grantId ?? 'preflight'}`)
    if (!actor) return refused()

    try {
      return await handler({ claims, actor })
    } catch (e) {
      return problemForError(e)
    }
  }
}
```

- [ ] **Step 6: Implement the routes**

Create `apps/control-plane/src/app/api/internal/v1/oauth-keys/route.ts`:

```ts
import { parseMcpResource } from '@metamodels/schema'
import { publishConfigInvalidation } from '../../../../../server/config-publisher'
import { loadDataPlaneUrl } from '../../../../../server/data-plane-url'
import { getDb } from '../../../../../server/db'
import { NotFoundError } from '../../../../../server/flocks-service'
import { withConsentAssertion } from '../../../../../server/internal-route'
import { mintOauthKey } from '../../../../../server/keys-service'

/**
 * The consent-time mint (M4 D7), called by the OP on Approve over the compose network. The OP saves
 * its grant only after this answers 200, so no grant ever exists without a key. 403 (no
 * `resource.write`) and 404 (unknown, disabled or foreign paddock) come from `mintOauthKey` through
 * `problemForError`. The invalidation is published here because `keys-service` never publishes; every
 * surface that calls it does (the console's actions, `withAdmin`).
 */
export const POST = withConsentAssertion(async ({ claims, actor }) => {
  const slug = parseMcpResource(loadDataPlaneUrl(), claims.resource)
  if (slug === null) throw new NotFoundError('paddock')
  const minted = await mintOauthKey(getDb(), actor, {
    clientId: claims.clientId,
    clientName: claims.clientName,
    paddockSlug: slug,
    grantId: claims.grantId!,
  })
  await publishConfigInvalidation(minted.outcome === 'created' ? 'key.create' : 'key.rebind')
  return Response.json({ key_id: minted.keyId })
}, { requireGrant: true })
```

Create `apps/control-plane/src/app/api/internal/v1/oauth-keys/preflight/route.ts`:

```ts
import { parseMcpResource } from '@metamodels/schema'
import { loadDataPlaneUrl } from '../../../../../../server/data-plane-url'
import { getDb } from '../../../../../../server/db'
import { withConsentAssertion } from '../../../../../../server/internal-route'
import { preflightOauthKey } from '../../../../../../server/keys-service'

/** Read-only: may this user approve this client for this paddock? Asked before the consent screen renders. */
export const GET = withConsentAssertion(async ({ claims, actor }) =>
  Response.json(await preflightOauthKey(getDb(), actor, parseMcpResource(loadDataPlaneUrl(), claims.resource))),
{ requireGrant: false })
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @metamodels/control-plane exec vitest run --testTimeout=30000 src/server/internal-oauth-keys.test.ts`
Expected: PASS.

- [ ] **Step 8: Prove the routes stay out of the public contract**

Run: `pnpm --filter @metamodels/control-plane gen:openapi && git diff --exit-code docs/api/openapi.json && grep -c internal docs/api/openapi.json`
Expected: no diff, and `0`.

- [ ] **Step 9: Run the lanes and the typecheck**

Run: `pnpm --filter @metamodels/control-plane exec vitest run --testTimeout=30000 && pnpm test && pnpm --filter @metamodels/control-plane build && pnpm -w exec tsc -b`
Expected: PASS; the build lists `/api/internal/v1/oauth-keys` and `/api/internal/v1/oauth-keys/preflight` as dynamic routes.

- [ ] **Step 10: Commit**

```bash
git add apps/control-plane/src .env.example
git commit -m "feat(control-plane): internal oauth-keys routes opened only by an OP-signed consent assertion"
```

---

### Task 5: The OP admits CIMD clients

Spec §3.4 (D4a). CIMD on, acknowledged as `draft-02`; admission open to any well-formed https client document that is a public client with only the code and refresh grants and safe redirect URIs; on only for an https or loopback-http issuer; and never without oidc-provider's SSRF guard. The auth service also learns the two URLs M4 needs: `DATA_PLANE_URL` and `CONTROL_PLANE_INTERNAL_URL`.

**Files:**
- Modify: `apps/auth/src/config.ts`
- Create: `apps/auth/src/cimd.ts`
- Create: `apps/auth/src/oidc-provider-internals.d.ts`
- Modify: `apps/auth/src/provider.ts`
- Modify: `apps/auth/test/helpers/flow.ts`
- Modify: `apps/auth/test/config.test.ts`, `apps/auth/test/env-docs.test.ts`, `apps/auth/test/server.test.ts`
- Modify: `.env.example`
- Test: `apps/auth/test/cimd.test.ts`

**Interfaces:**
- Consumes: `requireOrigin` (Task 1).
- Produces:
  - `AuthConfig.dataPlaneUrl: string` (`DATA_PLANE_URL`, required); `AuthConfig.controlPlaneInternalUrl: string` (`CONTROL_PLANE_INTERNAL_URL`, default `http://control-plane:3000`).
  - `CIMD_ACK = 'draft-02'`; `cimdGateForIssuer(issuer): { enabled: true } | { enabled: false; reason: string }`; `isLoopbackHost(hostname): boolean`; `isAcceptableRedirectUri(uri): boolean`; `cimdClientAllowed(client): boolean`; `cimdFeature()`; `isCimdClient(client: unknown): boolean`; `ssrfGuardAvailable(): boolean`; `cimdFixtureFetch(documents: Record<string, ClientMetadata>): NonNullable<Configuration['fetch']>`.
  - `ProviderOptions.fetch?: Configuration['fetch']`; `ProviderOptions.ssrfGuardAvailable?: () => boolean`.
  - Test helpers (`apps/auth/test/helpers/flow.ts`): `DATA_PLANE_URL = 'http://dp.test'`, `CIMD_CLIENT_ID`, `CIMD_REDIRECT_URI`, `cimdDocument(over?)`, `authConfig(issuer, over?)`, `startTestOp({ …, cimdDocuments?, providerOptions? })`, and `TestOp.provider`.

- [ ] **Step 1: Teach the config and its tests the two URLs**

In `apps/auth/src/config.ts`: add `import { requireOrigin } from '@metamodels/schema'`; add to `AuthConfig`:

```ts
  /**
   * Public origin of the data plane. Every MCP resource is `${dataPlaneUrl}/p/<slug>/mcp`
   * (`mcpResource`), so the OP resolves resource indicators against it (M4 D2).
   */
  dataPlaneUrl: string
  /** Where the OP reaches the control plane's internal routes over the compose network (M4 D7). */
  controlPlaneInternalUrl: string
```

and to the object `loadAuthConfig` returns:

```ts
    dataPlaneUrl: requireOrigin('DATA_PLANE_URL', env.DATA_PLANE_URL),
    controlPlaneInternalUrl: env.CONTROL_PLANE_INTERNAL_URL?.trim()
      ? requireOrigin('CONTROL_PLANE_INTERNAL_URL', env.CONTROL_PLANE_INTERNAL_URL)
      : 'http://control-plane:3000',
```

In `apps/auth/test/config.test.ts`: add `DATA_PLANE_URL: 'https://dp.example.test',` to the `env()` defaults, add `'DATA_PLANE_URL'` to the `test.each([...])('names %s when it is missing')` list, and append:

```ts
test('DATA_PLANE_URL is an origin, and CONTROL_PLANE_INTERNAL_URL defaults to the compose service', () => {
  const cfg = loadAuthConfig(env({ DATA_PLANE_URL: 'https://dp.example.test/' }))
  expect(cfg.dataPlaneUrl).toBe('https://dp.example.test')
  expect(cfg.controlPlaneInternalUrl).toBe('http://control-plane:3000')
  expect(loadAuthConfig(env({ CONTROL_PLANE_INTERNAL_URL: 'http://cp:3000' })).controlPlaneInternalUrl).toBe('http://cp:3000')
  expect(() => loadAuthConfig(env({ DATA_PLANE_URL: 'https://dp.example.test/p' }))).toThrow('DATA_PLANE_URL must be an origin')
})
```

In `apps/auth/test/env-docs.test.ts`, add `DATA_PLANE_URL: 'https://dp.example.test',` to `valid`. In `apps/auth/test/server.test.ts`, add `dataPlaneUrl: 'http://dp.test', controlPlaneInternalUrl: 'http://cp.test',` to `testConfig()`.

In `.env.example`, after `OIDC_INTERNAL_URL=…`:

```bash
# How the sign-in service reaches the console's internal routes (the compose network), to record an
# MCP app a user approved. Defaults to http://control-plane:3000.
CONTROL_PLANE_INTERNAL_URL=http://control-plane:3000
```

- [ ] **Step 2: Give the test harness a CIMD client**

In `apps/auth/test/helpers/flow.ts`:
- import `type Provider` and `type ClientMetadata` from `oidc-provider` (the latter is already imported), `type ProviderOptions` from `../../src/provider.js`, and `cimdFixtureFetch` from `../../src/cimd.js`;
- add `provider: Provider` to `TestOp`;
- add, above `startTestOp`:

```ts
export const DATA_PLANE_URL = 'http://dp.test'
/** Never fetched from the network: `cimdFixtureFetch` answers for it. */
export const CIMD_CLIENT_ID = 'https://mcp-client.example.test/client.json'
/** A native client's loopback redirect (RFC 8252 §7.3). Nothing listens on it: tests stop at the redirect. */
export const CIMD_REDIRECT_URI = 'http://127.0.0.1:43210/callback'

/** A well-formed public MCP client's Client ID Metadata Document. */
export function cimdDocument(over: Partial<ClientMetadata> = {}): ClientMetadata {
  return {
    client_id: CIMD_CLIENT_ID,
    client_name: 'Test MCP client',
    redirect_uris: [CIMD_REDIRECT_URI],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'native',
    ...over,
  }
}

/** The configuration every test OP runs with, on `issuer`. */
export function authConfig(issuer: string, over: Partial<AuthConfig> = {}): AuthConfig {
  return {
    issuer,
    consoleUrl: CONSOLE_URL,
    consoleClientSecret: CONSOLE_SECRET,
    cookieKeys: ['cookie-key-0123456789abcdef'],
    signingKeyPem: null,
    previousSigningKeyPems: [],
    allowEphemeralKey: true,
    databaseUrl: 'unused-in-tests',
    port: 0,
    dataPlaneUrl: DATA_PLANE_URL,
    controlPlaneInternalUrl: 'http://cp.test',
    ...over,
  }
}
```

- replace `startTestOp` with:

```ts
/** A real OP on an ephemeral port, backed by a fresh pglite database. */
export async function startTestOp(
  opts: {
    extraClients?: ClientMetadata[]
    signingKeyPem?: string
    previousSigningKeyPems?: string[]
    /** CIMD documents the OP "fetches", by client_id. */
    cimdDocuments?: Record<string, ClientMetadata>
    providerOptions?: ProviderOptions
  } = {},
): Promise<TestOp> {
  const db = await makeDb()
  let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => { res.statusCode = 503; res.end() }
  const server = createServer((req, res) => handler(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  // The issuer must be known before the provider exists, so the port is taken first.
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const cfg = authConfig(issuer, {
    signingKeyPem: opts.signingKeyPem ?? null,
    previousSigningKeyPems: opts.previousSigningKeyPems ?? [],
  })
  const provider = createProvider(cfg, db, {
    extraClients: opts.extraClients,
    ...(opts.cimdDocuments ? { fetch: cimdFixtureFetch(opts.cimdDocuments) } : {}),
    ...opts.providerOptions,
  })
  handler = provider.callback()
  return {
    issuer,
    db,
    provider,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}
```

- [ ] **Step 3: Write the failing CIMD tests**

Create `apps/auth/test/cimd.test.ts`:

```ts
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, test, vi } from 'vitest'
import fetchRequest, { isSpecialUseIP } from 'oidc-provider/lib/helpers/fetch_request.js'
import {
  CIMD_ACK, cimdClientAllowed, cimdFeature, cimdGateForIssuer, isAcceptableRedirectUri, isCimdClient, ssrfGuardAvailable,
} from '../src/cimd.js'
import { createProvider } from '../src/provider.js'
import { makeDb } from './helpers/db.js'
import {
  authConfig, CIMD_CLIENT_ID, CIMD_REDIRECT_URI, cimdDocument, CookieJar, pkcePair, send, startTestOp, type TestOp,
} from './helpers/flow.js'

const T = 20_000
let op: TestOp | undefined
afterEach(async () => { await op?.close(); op = undefined; vi.restoreAllMocks() })

/** The first hop of a CIMD client's authorization request. */
async function authorizeFirstHop(clientId: string): Promise<Response> {
  const { challenge } = pkcePair()
  const url = new URL(`${op!.issuer}/auth`)
  url.search = new URLSearchParams({
    client_id: clientId, response_type: 'code', scope: 'openid', redirect_uri: CIMD_REDIRECT_URI,
    state: 's', code_challenge: challenge, code_challenge_method: 'S256',
  }).toString()
  return send(new CookieJar(), url.href)
}

describe('CIMD is enabled, acknowledged and advertised (M4 D4a)', () => {
  test('the acknowledged draft is draft-02: an oidc-provider that moves the draft fails here and at construction', async () => {
    expect(CIMD_ACK).toBe('draft-02')
    expect(cimdFeature()).toMatchObject({ enabled: true, ack: 'draft-02' })
    op = await startTestOp()
    const meta = await (await fetch(`${op.issuer}/.well-known/openid-configuration`)).json()
    expect(meta.client_id_metadata_document_supported).toBe(true)
    expect(meta.registration_endpoint).toBeUndefined()
  }, T)

  test('a CIMD client resolves from its document and starts an interaction', async () => {
    op = await startTestOp({ cimdDocuments: { [CIMD_CLIENT_ID]: cimdDocument() } })
    const res = await authorizeFirstHop(CIMD_CLIENT_ID)
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toMatch(/^\/interaction\//)
    expect(isCimdClient(await op.provider.Client.find(CIMD_CLIENT_ID))).toBe(true)
  }, T)

  test('a document asking for a client secret, or for another grant, is not admitted', async () => {
    const secret = 'https://secret.example.test/client.json'
    const implicit = 'https://implicit.example.test/client.json'
    op = await startTestOp({
      cimdDocuments: {
        [secret]: cimdDocument({ client_id: secret, token_endpoint_auth_method: 'client_secret_basic' }),
        [implicit]: cimdDocument({ client_id: implicit, grant_types: ['authorization_code', 'client_credentials'] }),
      },
    })
    for (const id of [secret, implicit]) {
      const res = await authorizeFirstHop(id)
      expect(res.status, id).toBe(400)
      expect(await res.text(), id).toContain('Sign-in error')
    }
  }, T)

  test('first-party clients are not CIMD clients', async () => {
    op = await startTestOp()
    expect(isCimdClient(await op.provider.Client.find('metamodels-cli'))).toBe(false)
    expect(isCimdClient(undefined)).toBe(false)
  }, T)
})

describe('the issuer-scheme gate', () => {
  test('https, and plain http to a loopback host, turn CIMD on', () => {
    for (const issuer of ['https://auth.example.test', 'http://localhost:3100', 'http://127.0.0.1:3100', 'http://[::1]:3100']) {
      expect(cimdGateForIssuer(issuer), issuer).toEqual({ enabled: true })
    }
  })

  test('any other issuer boots with CIMD off, and says why', async () => {
    const gate = cimdGateForIssuer('http://auth.example.test')
    expect(gate).toMatchObject({ enabled: false, reason: expect.stringContaining('http://auth.example.test') })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const provider = createProvider(authConfig('http://auth.example.test'), await makeDb())
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Client ID Metadata Documents are off'))
    const server = createServer(provider.callback())
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      const meta = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/.well-known/openid-configuration`)).json()
      expect(meta.client_id_metadata_document_supported).toBeUndefined()
    } finally {
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
    }
  }, T)
})

describe('the admission policy', () => {
  const allowFetch = (id: string) => cimdFeature().allowFetch(undefined as never, id)

  test('allowFetch accepts only the library\'s own well-formed client id URLs', () => {
    expect(allowFetch('https://client.example.test/cimd.json')).toBe(true)
    for (const id of [
      'http://client.example.test/cimd.json', 'https://client.example.test/cimd.json#x',
      'https://user@client.example.test/cimd.json', 'https://client.example.test/a/../cimd.json',
    ]) expect(allowFetch(id), id).toBe(false)
  })

  test('allowClient: public, code and refresh only, https or loopback redirects', () => {
    const ok = { tokenEndpointAuthMethod: 'none', grantTypes: ['authorization_code', 'refresh_token'], redirectUris: ['https://app.example.test/cb', 'http://127.0.0.1:9/cb'] }
    expect(cimdClientAllowed(ok)).toBe(true)
    expect(cimdClientAllowed({ ...ok, tokenEndpointAuthMethod: 'private_key_jwt' })).toBe(false)
    expect(cimdClientAllowed({ ...ok, grantTypes: ['authorization_code', 'urn:ietf:params:oauth:grant-type:device_code'] })).toBe(false)
    expect(cimdClientAllowed({ ...ok, grantTypes: [] })).toBe(false)
    expect(cimdClientAllowed({ ...ok, redirectUris: ['http://app.example.test/cb'] })).toBe(false)
    expect(cimdClientAllowed({ ...ok, redirectUris: [] })).toBe(false)
  })

  test('a redirect URI is https, or http to a loopback host, and has no fragment', () => {
    for (const uri of ['https://a.test/cb', 'http://localhost:8080/cb', 'http://127.0.0.1/cb', 'http://[::1]:1/cb']) {
      expect(isAcceptableRedirectUri(uri), uri).toBe(true)
    }
    for (const uri of ['http://a.test/cb', 'https://a.test/cb#f', 'custom:/cb', 'not a url']) {
      expect(isAcceptableRedirectUri(uri), uri).toBe(false)
    }
  })
})

describe('SSRF: the CIMD fetch cannot reach special-use addresses (M4 §3.4)', () => {
  test('the guard oidc-provider installs is present in this runtime', () => {
    expect(ssrfGuardAvailable()).toBe(true)
  })

  test('a fetch to 127.0.0.1, and to a name that resolves to loopback, is refused on connect', async () => {
    const server = createServer((_req, res) => res.end('reachable'))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    const provider = createProvider(authConfig('http://127.0.0.1:1'), await makeDb())
    try {
      // Control: the server is really there.
      expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200)
      for (const url of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`]) {
        const err = await fetchRequest(provider, url, { method: 'GET', headers: {} }).then(() => null, (e: unknown) => e)
        expect(err, url).not.toBeNull()
        expect(String((err as Error & { cause?: Error }).cause?.message ?? err), url).toContain('special-use IP address')
      }
    } finally {
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
    }
  }, T)

  test('RFC 1918, CGNAT and link-local space are all special-use; public space is not', () => {
    for (const ip of ['10.1.2.3', '172.16.5.4', '172.31.255.1', '192.168.255.254', '100.64.0.1', '169.254.1.1', '::1', 'fd00::1']) {
      expect(isSpecialUseIP(ip), ip).toBe(true)
    }
    expect(isSpecialUseIP('8.8.8.8')).toBe(false)
  })

  test('without the guard, the OP refuses to start with CIMD on', async () => {
    expect(() => createProvider(authConfig('http://127.0.0.1:1'), {} as never, { ssrfGuardAvailable: () => false }))
      .toThrow(/SSRF guard/)
  })
})
```

- [ ] **Step 4: Run it to verify it fails**

Run: `pnpm exec vitest run apps/auth/test/cimd.test.ts`
Expected: FAIL — `Cannot find module '../src/cimd.js'`.

- [ ] **Step 5: Declare the two library internals this plan relies on**

oidc-provider ships no `exports` map, so its helper modules are importable; `@types/oidc-provider` does not describe them. Create `apps/auth/src/oidc-provider-internals.d.ts` (a global declaration file: no top-level import or export):

```ts
// Two oidc-provider 9.12 helpers used on purpose. `isValidClientIdUrl` is the library's own CIMD
// client-id check (https, no fragment, no userinfo, no dot-segments); `fetch_request` is the fetch
// its CIMD resolution uses, which installs the SSRF guard. If a minor release moves either file,
// the imports below fail at build time and in `test/cimd.test.ts`, not silently.
declare module 'oidc-provider/lib/helpers/client_id_metadata_document.js' {
  export function isValidClientIdUrl(id: string): boolean
}

declare module 'oidc-provider/lib/helpers/fetch_request.js' {
  import type Provider from 'oidc-provider'
  export default function fetchRequest(provider: Provider, url: string, options: RequestInit): Promise<Response>
  export function isSpecialUseIP(address: string): boolean
}
```

- [ ] **Step 6: Write the CIMD module**

Create `apps/auth/src/cimd.ts`:

```ts
import type { Client, ClientMetadata, Configuration, KoaContextWithOIDC } from 'oidc-provider'
import { isValidClientIdUrl } from 'oidc-provider/lib/helpers/client_id_metadata_document.js'

/**
 * The Client ID Metadata Document draft this OP implements. oidc-provider refuses to construct when
 * the acknowledged draft is not the one it ships, so a minor release that moves the draft fails at
 * boot and in `test/cimd.test.ts`, never as a silent behaviour change (spec §8).
 */
export const CIMD_ACK = 'draft-02'

const ALLOWED_GRANT_TYPES: ReadonlySet<string> = new Set(['authorization_code', 'refresh_token'])

/** `localhost`, 127.0.0.0/8 and `[::1]`, as `URL.hostname` spells them. */
export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname)
}

export type CimdGate = { enabled: true } | { enabled: false; reason: string }

/**
 * CIMD only on an issuer a remote client can trust: https, or plain http on a loopback host for local
 * clients and e2e. Any other issuer boots with CIMD off (spec §3.4).
 */
export function cimdGateForIssuer(issuer: string): CimdGate {
  const u = new URL(issuer)
  if (u.protocol === 'https:') return { enabled: true }
  if (u.protocol === 'http:' && isLoopbackHost(u.hostname)) return { enabled: true }
  return { enabled: false, reason: `OIDC_ISSUER (${u.origin}) is neither https nor http on a loopback host` }
}

/** https, or http to a loopback host (a native app's RFC 8252 redirect); never a fragment. */
export function isAcceptableRedirectUri(uri: string): boolean {
  const u = URL.parse(uri)
  if (!u || u.hash) return false
  return u.protocol === 'https:' || (u.protocol === 'http:' && isLoopbackHost(u.hostname))
}

/**
 * `allowClient`: every CIMD client must be a public client (`none`), use only the authorization-code
 * and refresh grants, and name only acceptable redirect URIs. PKCE S256 is already required for every
 * client (`pkce.required`).
 */
export function cimdClientAllowed(
  client: { tokenEndpointAuthMethod?: string; grantTypes?: readonly string[]; redirectUris?: readonly string[] },
): boolean {
  if (client.tokenEndpointAuthMethod !== 'none') return false
  const grants = client.grantTypes ?? []
  if (grants.length === 0 || !grants.every((g) => ALLOWED_GRANT_TYPES.has(g))) return false
  const uris = client.redirectUris ?? []
  return uris.length > 0 && uris.every(isAcceptableRedirectUri)
}

/**
 * `features.clientIdMetadataDocument`. Admission is open (D4a): any client whose id passes the
 * library's own `isValidClientIdUrl` may be fetched, and the consent screen is the gate. An
 * allowlist, if one is ever wanted, is additive here.
 */
export function cimdFeature() {
  return {
    enabled: true as const,
    ack: CIMD_ACK,
    allowFetch: (_ctx: KoaContextWithOIDC, clientId: string) => isValidClientIdUrl(clientId),
    allowClient: (_ctx: KoaContextWithOIDC, client: Client) => cimdClientAllowed(client),
  }
}

/** oidc-provider marks a client built from a metadata document with a non-enumerable `clientIdMetadataDocument: true`. */
export function isCimdClient(client: unknown): boolean {
  return typeof client === 'object' && client !== null
    && (client as { clientIdMetadataDocument?: unknown }).clientIdMetadataDocument === true
}

/**
 * Whether oidc-provider's CIMD fetch will carry its SSRF guard. The library builds the guard from
 * undici's global dispatcher (`lib/helpers/fetch_request.js`, `getAgent`) and, when that is missing,
 * silently fetches with no guard. This is the same lookup, so the OP can refuse to start instead.
 */
export function ssrfGuardAvailable(): boolean {
  void Response // Touching a fetch global is what makes Node install undici's global dispatcher.
  const g = globalThis as unknown as Record<symbol, { constructor?: unknown } | undefined>
  const dispatcher = g[Symbol.for('undici.globalDispatcher.2')] ?? g[Symbol.for('undici.globalDispatcher.1')]
  return typeof dispatcher?.constructor === 'function' && dispatcher.constructor !== Object
}

/**
 * A `configuration.fetch` that answers the given client ids from memory and hands every other URL to
 * the real fetch — with the options oidc-provider passed, so the SSRF guard still applies to those.
 * For tests and the e2e OP only (Task 15); production leaves `fetch` unset.
 */
export function cimdFixtureFetch(documents: Readonly<Record<string, ClientMetadata>>): NonNullable<Configuration['fetch']> {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!Object.hasOwn(documents, url)) return fetch(input, init)
    return new Response(JSON.stringify(documents[url]), { status: 200, headers: { 'content-type': 'application/json' } })
  }
}
```

- [ ] **Step 7: Wire it into the provider**

In `apps/auth/src/provider.ts`:
- import `{ cimdFeature, cimdGateForIssuer, ssrfGuardAvailable }` from `./cimd.js`;
- extend `ProviderOptions`:

```ts
  /**
   * Replaces oidc-provider's outbound fetch. Tests and the e2e OP answer CIMD documents through it
   * (`cimdFixtureFetch`); production leaves it unset.
   */
  fetch?: Configuration['fetch']
  /** Whether the SSRF guard is installed. Injectable so the boot refusal can be tested. */
  ssrfGuardAvailable?: () => boolean
```

- at the top of `createProvider`, before `configuration`:

```ts
  const cimd = cimdGateForIssuer(cfg.issuer)
  if (cimd.enabled && !(opts.ssrfGuardAvailable ?? ssrfGuardAvailable)()) {
    throw new Error(
      'Client ID Metadata Documents need oidc-provider\'s SSRF guard, and it is not installed (no undici ' +
      'global dispatcher). Refusing to start rather than fetch client documents unguarded.')
  }
  if (!cimd.enabled) {
    // eslint-disable-next-line no-console
    console.warn(`[auth] Client ID Metadata Documents are off: ${cimd.reason}`)
  }
```

- in `features`, add `clientIdMetadataDocument: cimd.enabled ? cimdFeature() : { enabled: false },`
- after `rotateRefreshToken: true,` add `...(opts.fetch ? { fetch: opts.fetch } : {}),`

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm exec vitest run apps/auth/test/cimd.test.ts apps/auth/test/config.test.ts apps/auth/test/env-docs.test.ts apps/auth/test/server.test.ts`
Expected: PASS.

- [ ] **Step 9: Run the whole auth suite and the lanes**

Run: `pnpm exec vitest run apps/auth && pnpm test && pnpm -w exec tsc -b`
Expected: PASS. Every existing auth test (console flow, device flow, CLI sign-out, revocation) is unaffected: they run on a loopback issuer, so CIMD is on but unused.

- [ ] **Step 10: Commit**

```bash
git add apps/auth/src apps/auth/test .env.example
git commit -m "feat(auth): admit Client ID Metadata Document clients behind the SSRF guard"
```

---

### Task 6: MCP resources resolve per paddock, and every MCP token names its key

Spec §3.2 (D2) and §3.1 *The token names the key*. `getResourceServerInfo` answers a `<DATA_PLANE_URL>/p/<slug>/mcp` resource for a CIMD client when the paddock is active (15-minute JWT, scope `mcp`); `extraTokenClaims` adds `mm_kid` — the id of the active oauth key bound to this grant for this paddock — and refuses to issue (`invalid_grant`) when there is none, so a revoked key cannot be refreshed back to life.

It also overrides two of oidc-provider's refresh defaults, for MCP only (ruling R4). The defaults (`lib/helpers/defaults.js:301-310` in 9.12.2) issue a refresh token only when the code carries `offline_access`, and bind a token without it to the OP browser session (`expiresWithSession`, enforced by `checkSessionBinding` in `lib/models/token_helpers.js`). `offline_access` is itself dropped unless the request says `prompt=consent` (`lib/actions/authorization/scopes.js:33-40`), and real MCP clients send neither. So `issueRefreshToken` returns true, and `expiresWithSession` returns false, when all three of these hold:

- the client is a CIMD client;
- `client.grantTypeAllowed('refresh_token')` is true;
- the code's `resource` names an MCP resource.

Every other source gets the default verbatim, so the console and the CLI are unchanged. Without the `expiresWithSession` half, an MCP refresh token would die when the approving browser's OP session ends (12 hours), which defeats the point of issuing it.

**Files:**
- Create: `apps/auth/src/paddocks.ts`
- Modify: `apps/auth/src/resources.ts`
- Modify: `apps/auth/src/provider.ts`
- Test: `apps/auth/test/mcp-resources.test.ts`

**Interfaces:**
- Consumes: `parseMcpResource`, `MCP_SCOPE` (Task 1); `isCimdClient` (Task 5).
- Produces:
  - `interface PaddockSummary { id: string; orgId: string; slug: string; name: string; status: string }`; `findPaddock(db, slug): Promise<PaddockSummary | null>`; `activeOauthKeyForGrant(db, grantId, slug): Promise<string | null>`.
  - `MCP_ACCESS_TOKEN_TTL = 900`; `mcpResourceServer(): ResourceServer`; `interface McpResources { dataPlaneUrl: string; isActivePaddock(slug: string): Promise<boolean> }`; `makeGetResourceServerInfo(servers, allowedByClient, mcp?: McpResources)`.
  - `makeExtraTokenClaims(db: Db, dataPlaneUrl: string)` → `(ctx, token) => Promise<{ mm_kid: string } | undefined>`.
  - `mcpRefreshPolicy(dataPlaneUrl: string)` → `{ issueRefreshToken(ctx, client, source): Promise<boolean>; expiresWithSession(ctx, source): Promise<boolean> }`, where `RefreshSource = { resource?: string | string[]; scopes: ReadonlySet<string> }` and `RefreshClient = { grantTypeAllowed(type: string): boolean }`.

- [ ] **Step 1: Write the failing tests**

Create `apps/auth/test/mcp-resources.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { errors } from 'oidc-provider'
import * as schema from '@metamodels/schema'
import { adminApiResource, CLI_CLIENT_ID, mcpResource } from '@metamodels/schema'
import {
  makeExtraTokenClaims, makeGetResourceServerInfo, MCP_ACCESS_TOKEN_TTL, mcpRefreshPolicy, resourcesByClient, resourceServers,
} from '../src/resources.js'
import { activeOauthKeyForGrant, findPaddock } from '../src/paddocks.js'
import { makeDb, type TestDb } from './helpers/db.js'
import { CONSOLE_URL, DATA_PLANE_URL } from './helpers/flow.js'

const cimd = { clientId: 'https://mcp-client.example.test/client.json', clientIdMetadataDocument: true }
const cli = { clientId: CLI_CLIENT_ID }

async function world() {
  const db = await makeDb()
  const [o] = await db.insert(schema.org).values({ name: 'o' }).returning()
  const [u] = await db.insert(schema.user).values({ orgId: o.id, email: 'm@x.io', passwordHash: 'x', role: 'member' }).returning()
  const [f] = await db.insert(schema.flock).values({ orgId: o.id, breed: 'ollama', name: 'f', baseUrl: 'http://f' }).returning()
  const [small] = await db.insert(schema.paddock).values({ orgId: o.id, flockId: f.id, slug: 'small', name: 'Small models' }).returning()
  const [big] = await db.insert(schema.paddock).values({ orgId: o.id, flockId: f.id, slug: 'big', name: 'Big models' }).returning()
  await db.insert(schema.paddock).values({ orgId: o.id, flockId: f.id, slug: 'off', name: 'Off', status: 'disabled' })
  return { db, o, u, small, big }
}

async function oauthKey(db: TestDb, w: Awaited<ReturnType<typeof world>>, paddockId: string, grantId: string, status = 'active') {
  const [k] = await db.insert(schema.apiKey).values({
    orgId: w.o.id, name: 'k', prefix: 'oauth', hash: randomBytes(32).toString('hex'), status,
    kind: 'oauth', grantId, oauthClientId: cimd.clientId, userId: w.u.id,
  }).returning()
  await db.insert(schema.keyPaddock).values({ keyId: k.id, paddockId })
  return k.id
}

function resolver(db: TestDb) {
  return makeGetResourceServerInfo(resourceServers(CONSOLE_URL), resourcesByClient(CONSOLE_URL), {
    dataPlaneUrl: DATA_PLANE_URL,
    isActivePaddock: async (slug) => (await findPaddock(db, slug))?.status === 'active',
  })
}

describe('getResourceServerInfo — one resource per paddock (M4 D2)', () => {
  test('a CIMD client gets a 15-minute RS256 JWT scoped mcp for an active paddock', async () => {
    const { db } = await world()
    const rs = await resolver(db)(undefined, mcpResource(DATA_PLANE_URL, 'small'), cimd)
    expect(rs).toEqual({ scope: 'mcp', accessTokenFormat: 'jwt', accessTokenTTL: MCP_ACCESS_TOKEN_TTL, jwt: { sign: { alg: 'RS256' } } })
    expect(MCP_ACCESS_TOKEN_TTL).toBe(15 * 60)
  })

  test('an unknown or disabled paddock, a malformed slug and another data plane are invalid_target', async () => {
    const { db } = await world()
    for (const r of [
      mcpResource(DATA_PLANE_URL, 'nope'), mcpResource(DATA_PLANE_URL, 'off'),
      `${DATA_PLANE_URL}/p/Small/mcp`, mcpResource('https://elsewhere.test', 'small'),
    ]) {
      await expect(resolver(db)(undefined, r, cimd), r).rejects.toBeInstanceOf(errors.InvalidTarget)
    }
  })

  test('MCP resources are open only to CIMD clients; the admin API stays CLI-only', async () => {
    const { db } = await world()
    await expect(resolver(db)(undefined, mcpResource(DATA_PLANE_URL, 'small'), cli)).rejects.toBeInstanceOf(errors.InvalidTarget)
    await expect(resolver(db)(undefined, adminApiResource(CONSOLE_URL), cimd)).rejects.toBeInstanceOf(errors.InvalidTarget)
    expect((await resolver(db)(undefined, adminApiResource(CONSOLE_URL), cli)).accessTokenTTL).toBe(3600)
  })
})

describe('extraTokenClaims — the token names the key (M4 D1)', () => {
  const token = (resource: string | undefined, grantId: string | undefined) => ({
    grantId, resourceServer: resource === undefined ? undefined : { identifier: () => resource },
  })

  test('adds nothing to a token for no resource or for the admin API', async () => {
    const { db } = await world()
    const claims = makeExtraTokenClaims(db, DATA_PLANE_URL)
    expect(await claims(undefined, token(undefined, 'g1'))).toBeUndefined()
    expect(await claims(undefined, token(adminApiResource(CONSOLE_URL), 'g1'))).toBeUndefined()
  })

  test('an MCP token carries mm_kid: the active oauth key bound to its grant for its paddock', async () => {
    const w = await world()
    const kSmall = await oauthKey(w.db, w, w.small.id, 'g1')
    const kBig = await oauthKey(w.db, w, w.big.id, 'g1')
    const claims = makeExtraTokenClaims(w.db, DATA_PLANE_URL)
    expect(await claims(undefined, token(mcpResource(DATA_PLANE_URL, 'small'), 'g1'))).toEqual({ mm_kid: kSmall })
    expect(await claims(undefined, token(mcpResource(DATA_PLANE_URL, 'big'), 'g1'))).toEqual({ mm_kid: kBig })
  })

  test('a revoked key, another grant\'s key or no key at all refuses to issue with invalid_grant', async () => {
    const w = await world()
    const k = await oauthKey(w.db, w, w.small.id, 'g1')
    const claims = makeExtraTokenClaims(w.db, DATA_PLANE_URL)
    await expect(claims(undefined, token(mcpResource(DATA_PLANE_URL, 'small'), 'g2'))).rejects.toBeInstanceOf(errors.InvalidGrant)
    await expect(claims(undefined, token(mcpResource(DATA_PLANE_URL, 'small'), undefined))).rejects.toBeInstanceOf(errors.InvalidGrant)
    await w.db.update(schema.apiKey).set({ status: 'revoked' }).where(eq(schema.apiKey.id, k))
    await expect(claims(undefined, token(mcpResource(DATA_PLANE_URL, 'small'), 'g1'))).rejects.toBeInstanceOf(errors.InvalidGrant)
    expect(await activeOauthKeyForGrant(w.db, 'g1', 'small')).toBeNull()
  })

  test('a live key can never be named, whatever its columns say', async () => {
    const w = await world()
    const [live] = await w.db.insert(schema.apiKey).values({ orgId: w.o.id, name: 'l', prefix: 'mm_live_x', hash: 'h' }).returning()
    await w.db.insert(schema.keyPaddock).values({ keyId: live.id, paddockId: w.small.id })
    expect(await activeOauthKeyForGrant(w.db, 'g1', 'small')).toBeNull()
  })
})

describe('refresh tokens for MCP clients (ruling R4)', () => {
  const policy = mcpRefreshPolicy(DATA_PLANE_URL)
  const MCP = mcpResource(DATA_PLANE_URL, 'small')
  const client = (o: { cimd?: boolean; refresh?: boolean } = {}) => ({
    clientId: 'c',
    ...(o.cimd === false ? {} : { clientIdMetadataDocument: true }),
    grantTypeAllowed: (type: string) => (type === 'refresh_token' ? o.refresh !== false : true),
  })
  const source = (resource: string | string[] | undefined, scope = 'openid mcp') => ({ resource, scopes: new Set(scope.split(' ')) })
  const ctxFor = (c: ReturnType<typeof client>) => ({ oidc: { client: c } })

  test('a CIMD client bound to an MCP resource gets a refresh token without offline_access, not tied to the OP session', async () => {
    expect(await policy.issueRefreshToken(undefined, client(), source(MCP))).toBe(true)
    expect(await policy.issueRefreshToken(undefined, client(), source([MCP, adminApiResource(CONSOLE_URL)]))).toBe(true)
    expect(await policy.expiresWithSession(ctxFor(client()), source(MCP))).toBe(false)
  })

  test('without the refresh_token grant, or for no MCP resource, the default decides', async () => {
    expect(await policy.issueRefreshToken(undefined, client({ refresh: false }), source(MCP, 'openid offline_access mcp'))).toBe(false)
    expect(await policy.issueRefreshToken(undefined, client(), source(adminApiResource(CONSOLE_URL)))).toBe(false)
    expect(await policy.issueRefreshToken(undefined, client(), source(undefined, 'openid offline_access'))).toBe(true)
    expect(await policy.expiresWithSession(ctxFor(client()), source(undefined))).toBe(true)
  })

  test('a non-CIMD client is unchanged: offline_access alone decides, even for an MCP resource', async () => {
    const plain = client({ cimd: false })
    expect(await policy.issueRefreshToken(undefined, plain, source(MCP))).toBe(false)
    expect(await policy.issueRefreshToken(undefined, plain, source(MCP, 'openid offline_access'))).toBe(true)
    expect(await policy.expiresWithSession(ctxFor(plain), source(MCP))).toBe(true)
    expect(await policy.expiresWithSession(ctxFor(plain), source(MCP, 'openid offline_access'))).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run apps/auth/test/mcp-resources.test.ts`
Expected: FAIL — `Cannot find module '../src/paddocks.js'`, and `makeExtraTokenClaims` / `MCP_ACCESS_TOKEN_TTL` / `mcpRefreshPolicy` are not exported.

- [ ] **Step 3: Write the read-only lookups**

Create `apps/auth/src/paddocks.ts`:

```ts
import { and, eq } from 'drizzle-orm'
import { apiKey, keyPaddock, paddock } from '@metamodels/schema'
import type { Db } from './db.js'

/**
 * The OP's only reads of control-plane data besides `user` (M4 D2, D7). Read-only by construction:
 * nothing in this service writes these tables; `keys-service` in the control plane is their writer.
 */
export interface PaddockSummary {
  id: string
  orgId: string
  slug: string
  name: string
  status: string
}

export async function findPaddock(db: Db, slug: string): Promise<PaddockSummary | null> {
  const rows = await db
    .select({ id: paddock.id, orgId: paddock.orgId, slug: paddock.slug, name: paddock.name, status: paddock.status })
    .from(paddock)
    .where(eq(paddock.slug, slug))
    .limit(1)
  return rows[0] ?? null
}

/**
 * The active oauth key bound to `grantId` for the paddock `slug`, or null. One grant can back keys for
 * several paddocks — oidc-provider reuses a browser session's grant for a client across resources — so
 * the paddock is part of the lookup, not just the grant.
 */
export async function activeOauthKeyForGrant(db: Db, grantId: string, slug: string): Promise<string | null> {
  const rows = await db
    .select({ id: apiKey.id })
    .from(apiKey)
    .innerJoin(keyPaddock, eq(keyPaddock.keyId, apiKey.id))
    .innerJoin(paddock, eq(paddock.id, keyPaddock.paddockId))
    .where(and(eq(apiKey.grantId, grantId), eq(apiKey.kind, 'oauth'), eq(apiKey.status, 'active'), eq(paddock.slug, slug)))
    .limit(1)
  return rows[0]?.id ?? null
}
```

- [ ] **Step 4: Resolve MCP resources and name the key**

In `apps/auth/src/resources.ts`: extend the imports (`MCP_SCOPE`, `parseMcpResource` from `@metamodels/schema`; `isCimdClient` from `./cimd.js`; `activeOauthKeyForGrant` from `./paddocks.js`; `type Db` from `./db.js`), update the `resourceServers` comment's last sentence to *"MCP resources are not in this map: they are resolved per paddock by `makeGetResourceServerInfo`."*, then replace `makeGetResourceServerInfo` and append the rest:

```ts
/** MCP access tokens live 15 minutes: the data plane verifies offline, and a revoked key is otherwise caught only by its config check (spec §3.2). */
export const MCP_ACCESS_TOKEN_TTL = 15 * 60

export function mcpResourceServer(): ResourceServer {
  return { scope: MCP_SCOPE, accessTokenFormat: 'jwt', accessTokenTTL: MCP_ACCESS_TOKEN_TTL, jwt: { sign: { alg: 'RS256' } } }
}

export interface McpResources {
  /** `DATA_PLANE_URL`: MCP resources are `${dataPlaneUrl}/p/<slug>/mcp`. */
  dataPlaneUrl: string
  isActivePaddock(slug: string): Promise<boolean>
}

/**
 * oidc-provider's `getResourceServerInfo` — the per-client resource gate. oidc-provider consults it
 * for every resource a request names, at the authorization, device-authorization and token
 * endpoints and on every refresh, passing the requesting client as the third argument.
 *
 * An MCP resource (one per paddock, M4 D2) is resolved dynamically: it is open only to CIMD clients,
 * and only while its paddock is active — so disabling a paddock also stops its tokens refreshing.
 * Every other resource is the static map: it must be declared in `servers`, AND the client must be
 * listed in `allowedByClient` with that resource in its set. Everything else is `invalid_target`.
 */
export function makeGetResourceServerInfo(
  servers: ReadonlyMap<string, ResourceServer>,
  allowedByClient: ReadonlyMap<string, ReadonlySet<string>>,
  mcp?: McpResources,
) {
  return async (
    _ctx: unknown,
    resourceIndicator: string,
    client: Pick<Client, 'clientId'>,
  ): Promise<ResourceServer> => {
    const slug = mcp ? parseMcpResource(mcp.dataPlaneUrl, resourceIndicator) : null
    if (slug !== null) {
      if (!isCimdClient(client)) throw new errors.InvalidTarget()
      if (!(await mcp!.isActivePaddock(slug))) throw new errors.InvalidTarget()
      return mcpResourceServer()
    }
    const rs = servers.get(resourceIndicator)
    if (!rs) throw new errors.InvalidTarget()
    if (!allowedByClient.get(client.clientId)?.has(resourceIndicator)) throw new errors.InvalidTarget()
    return rs
  }
}

/**
 * oidc-provider's `extraTokenClaims`. For an MCP access token it adds `mm_kid`, the oauth key the data
 * plane meters and scopes the caller by. It runs every time such a token is issued, first issue and
 * every refresh alike, so a key revoked on the Keys page (or by a user losing their role) makes the
 * grant unable to mint another: `invalid_grant`, and the client must ask the user again.
 */
export function makeExtraTokenClaims(db: Db, dataPlaneUrl: string) {
  return async (_ctx: unknown, token: unknown): Promise<{ mm_kid: string } | undefined> => {
    const t = token as { grantId?: string; resourceServer?: { identifier(): string } }
    const resource = t.resourceServer?.identifier()
    const slug = resource === undefined ? null : parseMcpResource(dataPlaneUrl, resource)
    if (slug === null) return undefined
    if (!t.grantId) throw new errors.InvalidGrant('an MCP token must be issued under a grant')
    const keyId = await activeOauthKeyForGrant(db, t.grantId, slug)
    if (!keyId) throw new errors.InvalidGrant('the key behind this grant has been revoked')
    return { mm_kid: keyId }
  }
}

/** What oidc-provider hands `issueRefreshToken` / `expiresWithSession`: an authorization code (or device code). */
export interface RefreshSource {
  /** One resource indicator as a string, several as an array (`lib/helpers/process_response_types.js`). */
  resource?: string | string[]
  scopes: ReadonlySet<string>
}

export interface RefreshClient {
  grantTypeAllowed(type: string): boolean
}

/**
 * Refresh tokens for MCP clients (ruling R4). oidc-provider issues one only for `offline_access`, which
 * it drops unless the request says `prompt=consent`, and real MCP clients send neither. For a CIMD client
 * allowed the refresh_token grant whose code names an MCP resource, this issues one, and does not bind it
 * to the OP browser session (the approving user's 12-hour sign-in). Its life is M2's refresh policy, and
 * revoking the key ends it (`makeExtraTokenClaims`). Every other case is oidc-provider's default, verbatim
 * (`lib/helpers/defaults.js:301-310` in 9.12.2), so the console and the CLI are unchanged.
 */
export function mcpRefreshPolicy(dataPlaneUrl: string) {
  const namesMcp = (source: RefreshSource) => {
    const r = source.resource
    const list = r === undefined ? [] : Array.isArray(r) ? r : [r]
    return list.some((uri) => parseMcpResource(dataPlaneUrl, uri) !== null)
  }
  const isMcp = (client: unknown, source: RefreshSource) =>
    isCimdClient(client) && (client as RefreshClient).grantTypeAllowed('refresh_token') && namesMcp(source)

  return {
    async issueRefreshToken(_ctx: unknown, client: RefreshClient, source: RefreshSource): Promise<boolean> {
      if (isMcp(client, source)) return true
      return client.grantTypeAllowed('refresh_token') && source.scopes.has('offline_access')
    },
    async expiresWithSession(ctx: { oidc: { client?: unknown } }, source: RefreshSource): Promise<boolean> {
      if (isMcp(ctx.oidc.client, source)) return false
      return !source.scopes.has('offline_access')
    },
  }
}
```

In `apps/auth/src/provider.ts`: import `makeExtraTokenClaims` with the other `./resources.js` names and `findPaddock` from `./paddocks.js`; change `getResourceServerInfo` to:

```ts
        getResourceServerInfo: makeGetResourceServerInfo(resourceServers(cfg.consoleUrl), resourcesByClient(cfg.consoleUrl), {
          dataPlaneUrl: cfg.dataPlaneUrl,
          isActivePaddock: async (slug) => (await findPaddock(db, slug))?.status === 'active',
        }),
```

and add at the top level of `configuration` (beside `findAccount`; import `mcpRefreshPolicy` with the other `./resources.js` names, and compute `const refresh = mcpRefreshPolicy(cfg.dataPlaneUrl)` before `configuration`):

```ts
    extraTokenClaims: makeExtraTokenClaims(db, cfg.dataPlaneUrl) as NonNullable<Configuration['extraTokenClaims']>,
    // Ruling R4: MCP clients get refresh tokens without offline_access; everyone else keeps the defaults.
    issueRefreshToken: refresh.issueRefreshToken as NonNullable<Configuration['issueRefreshToken']>,
    expiresWithSession: refresh.expiresWithSession as NonNullable<Configuration['expiresWithSession']>,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run apps/auth/test/mcp-resources.test.ts apps/auth/test/resources.test.ts`
Expected: PASS — including every M1/M2 case in `resources.test.ts`, which call `makeGetResourceServerInfo` with two arguments. M2's refresh-token flows (`device-flow.test.ts`, `revocation.test.ts`, `cli-sign-out.test.ts`) run in Step 6 and must pass unchanged: they are the flow-level proof that non-CIMD clients kept the default.

- [ ] **Step 6: Run the auth suite and typecheck**

Run: `pnpm exec vitest run apps/auth && pnpm -w exec tsc -b`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/auth/src apps/auth/test/mcp-resources.test.ts
git commit -m "feat(auth): resolve one MCP resource per paddock, stamp mm_kid on its tokens, and issue MCP clients refresh tokens"
```

---

### Task 7: The OP signs its consent assertion and calls the control plane

Spec §3.5 (D7), the OP's side. `consentAsserter` signs the assertion with the OP's **current** signing key (the first key of its JWKS, the one oidc-provider signs with); `httpConsentApi` sends it to the two internal routes of Task 4 and turns their answers into what the consent screen needs.

**Files:**
- Create: `apps/auth/src/consent-api.ts`
- Test: `apps/auth/test/consent-api.test.ts`

**Interfaces:**
- Consumes: `signJwtRs256` (`@metamodels/schema/jws`, Task 2); `CONSENT_ASSERTION_TYP`, `internalApiAudience` (Task 1); `signingJwks` (`apps/auth/src/keys.ts`).
- Produces:
  - `interface ConsentRequest { accountId: string; clientId: string; clientName: string; resource: string }`
  - `type Preflight = { allowed: true } | { allowed: false; reason: string }`
  - `type MintOutcome = { ok: true; keyId: string } | { ok: false; kind: 'denied'; reason: string } | { ok: false; kind: 'error'; detail: string }`
  - `interface ConsentApi { preflight(r: ConsentRequest): Promise<Preflight>; mint(r: ConsentRequest & { grantId: string }): Promise<MintOutcome> }`
  - `CONSENT_ASSERTION_TTL_S = 30`; `PREFLIGHT_UNAVAILABLE`; `MINT_DENIED_ROLE`; `MINT_DENIED_PADDOCK`.
  - `consentAsserter(opts: { issuer: string; consoleUrl: string; signingJwk: JWK }): (r: ConsentRequest & { grantId?: string }) => string`
  - `httpConsentApi(opts: { baseUrl: string; assert: ReturnType<typeof consentAsserter>; fetchImpl?: typeof fetch }): ConsentApi`

- [ ] **Step 1: Write the failing tests**

Create `apps/auth/test/consent-api.test.ts`:

```ts
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createLocalJWKSet, jwtVerify, type JWK } from 'jose'
import { internalApiAudience } from '@metamodels/schema'
import {
  CONSENT_ASSERTION_TTL_S, consentAsserter, httpConsentApi, MINT_DENIED_PADDOCK, MINT_DENIED_ROLE, PREFLIGHT_UNAVAILABLE,
} from '../src/consent-api.js'
import { signingJwks } from '../src/keys.js'

const ISSUER = 'https://auth.example.test'
const CONSOLE = 'https://console.example.test'
const signer = signingJwks(null, true).keys[0]!
const publicJwk = (({ kty, n, e, kid, alg, use }) => ({ kty, n, e, kid, alg, use }))(signer as JWK & Record<string, string>)
const request = {
  accountId: '11111111-1111-4111-8111-111111111111', clientId: 'https://client.example.test/cimd.json',
  clientName: 'Claude', resource: 'https://dp.example.test/p/small/mcp',
}

describe('consentAsserter', () => {
  test('signs an mm-consent+jwt the control plane can verify against the OP\'s published key', async () => {
    const assert = consentAsserter({ issuer: ISSUER, consoleUrl: CONSOLE, signingJwk: signer })
    const jwt = assert({ ...request, grantId: 'grant-1' })
    const { payload, protectedHeader } = await jwtVerify(jwt, createLocalJWKSet({ keys: [publicJwk as JWK] }), {
      issuer: ISSUER, audience: internalApiAudience(CONSOLE), typ: 'mm-consent+jwt', algorithms: ['RS256'],
    })
    expect(protectedHeader.kid).toBe(signer.kid)
    expect(payload).toMatchObject({
      sub: request.accountId, client_id: request.clientId, client_name: 'Claude',
      resource: request.resource, grant_id: 'grant-1',
    })
    expect(payload.exp! - payload.iat!).toBe(CONSENT_ASSERTION_TTL_S)
    expect(CONSENT_ASSERTION_TTL_S).toBeLessThanOrEqual(60)
  })

  test('every assertion has its own jti, and a preflight assertion names no grant', async () => {
    const assert = consentAsserter({ issuer: ISSUER, consoleUrl: CONSOLE, signingJwk: signer })
    const read = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8'))
    const a = read(assert(request))
    const b = read(assert(request))
    expect(a.jti).not.toBe(b.jti)
    expect('grant_id' in a).toBe(false)
  })
})

describe('httpConsentApi', () => {
  let server: Server
  let base: string
  let seen: Array<{ method: string; url: string; auth: string | undefined }>
  let reply: { status: number; body: unknown }

  beforeEach(async () => {
    seen = []
    reply = { status: 200, body: {} }
    server = createServer((req, res) => {
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization })
      res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => { await new Promise<void>((r) => server.close(() => r())) })

  const api = () => httpConsentApi({ baseUrl: base, assert: (r) => `assertion-for-${r.grantId ?? 'preflight'}` })

  test('preflight GETs the internal route with the assertion as a bearer', async () => {
    reply = { status: 200, body: { allowed: true, reason: null } }
    expect(await api().preflight(request)).toEqual({ allowed: true })
    expect(seen).toEqual([{ method: 'GET', url: '/api/internal/v1/oauth-keys/preflight', auth: 'Bearer assertion-for-preflight' }])
  })

  test('preflight relays a refusal\'s reason, and turns any failure into a refusal', async () => {
    reply = { status: 200, body: { allowed: false, reason: 'Your role cannot approve apps.' } }
    expect(await api().preflight(request)).toEqual({ allowed: false, reason: 'Your role cannot approve apps.' })
    reply = { status: 500, body: {} }
    expect(await api().preflight(request)).toEqual({ allowed: false, reason: PREFLIGHT_UNAVAILABLE })
    const down = httpConsentApi({ baseUrl: 'http://127.0.0.1:1', assert: () => 'x' })
    expect(await down.preflight(request)).toEqual({ allowed: false, reason: PREFLIGHT_UNAVAILABLE })
  })

  test('mint POSTs and returns the key id', async () => {
    reply = { status: 200, body: { key_id: 'key-1' } }
    expect(await api().mint({ ...request, grantId: 'grant-1' })).toEqual({ ok: true, keyId: 'key-1' })
    expect(seen).toEqual([{ method: 'POST', url: '/api/internal/v1/oauth-keys', auth: 'Bearer assertion-for-grant-1' }])
  })

  test('mint: 403 and 404 are a denial with a reason; anything else is an error', async () => {
    reply = { status: 403, body: {} }
    expect(await api().mint({ ...request, grantId: 'g' })).toEqual({ ok: false, kind: 'denied', reason: MINT_DENIED_ROLE })
    reply = { status: 404, body: {} }
    expect(await api().mint({ ...request, grantId: 'g' })).toEqual({ ok: false, kind: 'denied', reason: MINT_DENIED_PADDOCK })
    reply = { status: 401, body: {} }
    expect(await api().mint({ ...request, grantId: 'g' })).toMatchObject({ ok: false, kind: 'error' })
    reply = { status: 200, body: {} }
    expect(await api().mint({ ...request, grantId: 'g' })).toMatchObject({ ok: false, kind: 'error' })
    const down = httpConsentApi({ baseUrl: 'http://127.0.0.1:1', assert: () => 'x' })
    expect(await down.mint({ ...request, grantId: 'g' })).toMatchObject({ ok: false, kind: 'error' })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run apps/auth/test/consent-api.test.ts`
Expected: FAIL — `Cannot find module '../src/consent-api.js'`.

- [ ] **Step 3: Implement the client**

Create `apps/auth/src/consent-api.ts`:

```ts
import { createPrivateKey, randomUUID } from 'node:crypto'
import type { JWK } from 'oidc-provider'
import { CONSENT_ASSERTION_TYP, internalApiAudience } from '@metamodels/schema'
import { signJwtRs256 } from '@metamodels/schema/jws'

/** Half the 60 s the control plane accepts: room for clock skew between the two services. */
export const CONSENT_ASSERTION_TTL_S = 30
const CALL_TIMEOUT_MS = 5_000

export const PREFLIGHT_UNAVAILABLE = 'MetaModels could not check this approval right now. Try again in a moment.'
export const MINT_DENIED_ROLE = 'Your role cannot approve apps.'
export const MINT_DENIED_PADDOCK = 'This paddock does not exist, is disabled, or is not in your organization.'

/** What the OP asserts: this user approved this client for this resource (and, on a mint, under this grant). */
export interface ConsentRequest {
  accountId: string
  clientId: string
  clientName: string
  resource: string
}

export type Preflight = { allowed: true } | { allowed: false; reason: string }

export type MintOutcome =
  | { ok: true; keyId: string }
  | { ok: false; kind: 'denied'; reason: string }
  | { ok: false; kind: 'error'; detail: string }

/** The control plane, as the consent screen sees it. Injectable so tests need no control plane. */
export interface ConsentApi {
  preflight(r: ConsentRequest): Promise<Preflight>
  mint(r: ConsentRequest & { grantId: string }): Promise<MintOutcome>
}

/**
 * Signs the consent assertion with the OP's current signing key — `signingJwks(…).keys[0]`, the key
 * oidc-provider itself signs with — so the control plane verifies it against the JWKS it already
 * trusts. `typ` and `aud` are fixed; the `jti` is fresh for every call and refused on replay.
 */
export function consentAsserter(opts: { issuer: string; consoleUrl: string; signingJwk: JWK }) {
  const { kid, alg: _alg, use: _use, ...material } = opts.signingJwk as JWK & Record<string, unknown>
  const key = createPrivateKey({ key: material as JsonWebKey, format: 'jwk' })
  const aud = internalApiAudience(opts.consoleUrl)
  return (r: ConsentRequest & { grantId?: string }): string => {
    const now = Math.floor(Date.now() / 1000)
    return signJwtRs256({ typ: CONSENT_ASSERTION_TYP, kid }, {
      iss: opts.issuer,
      aud,
      iat: now,
      exp: now + CONSENT_ASSERTION_TTL_S,
      jti: randomUUID(),
      sub: r.accountId,
      client_id: r.clientId,
      client_name: r.clientName,
      resource: r.resource,
      ...(r.grantId ? { grant_id: r.grantId } : {}),
    }, key)
  }
}

/** The control plane's `/api/internal/v1/oauth-keys` routes (Task 4), over `CONTROL_PLANE_INTERNAL_URL`. */
export function httpConsentApi(opts: {
  baseUrl: string
  assert: (r: ConsentRequest & { grantId?: string }) => string
  fetchImpl?: typeof fetch
}): ConsentApi {
  const doFetch = opts.fetchImpl ?? fetch
  const url = (suffix: string) => `${opts.baseUrl}/api/internal/v1/oauth-keys${suffix}`
  return {
    async preflight(r) {
      try {
        const res = await doFetch(url('/preflight'), {
          headers: { authorization: `Bearer ${opts.assert(r)}` },
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        })
        if (res.status !== 200) return { allowed: false, reason: PREFLIGHT_UNAVAILABLE }
        const body = (await res.json()) as { allowed?: unknown; reason?: unknown }
        if (body.allowed === true) return { allowed: true }
        return { allowed: false, reason: typeof body.reason === 'string' && body.reason ? body.reason : PREFLIGHT_UNAVAILABLE }
      } catch {
        return { allowed: false, reason: PREFLIGHT_UNAVAILABLE }
      }
    },
    async mint(r) {
      let res: Response
      try {
        res = await doFetch(url(''), {
          method: 'POST',
          headers: { authorization: `Bearer ${opts.assert(r)}` },
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        })
      } catch (e) {
        return { ok: false, kind: 'error', detail: `the control plane could not be reached: ${String(e)}` }
      }
      if (res.status === 200) {
        const body = (await res.json().catch(() => null)) as { key_id?: unknown } | null
        return typeof body?.key_id === 'string'
          ? { ok: true, keyId: body.key_id }
          : { ok: false, kind: 'error', detail: 'the control plane answered 200 with no key_id' }
      }
      // A refusal after a preflight said yes: the user's role or the paddock changed in between.
      if (res.status === 403) return { ok: false, kind: 'denied', reason: MINT_DENIED_ROLE }
      if (res.status === 404) return { ok: false, kind: 'denied', reason: MINT_DENIED_PADDOCK }
      return { ok: false, kind: 'error', detail: `the control plane answered ${res.status}` }
    },
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run apps/auth/test/consent-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm -w exec tsc -b`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/auth/src/consent-api.ts apps/auth/test/consent-api.test.ts
git commit -m "feat(auth): sign the consent assertion and call the control plane's oauth-keys routes"
```

---

### Task 8: The consent screen

Spec §4.3, §3.3 and §3.5 *The OP's side*. The M1 branch that refused every third-party client at consent is replaced, for CIMD clients asking for exactly one MCP resource, by a server-rendered consent screen. It asks the control plane's preflight first: a `viewer` (or a paddock outside the user's org) sees the reason and a Close button, never an Approve button. Approve calls the mint, then saves the grant — in that order, so no grant exists without a key; a failed mint ends the interaction with `server_error` and saves nothing. Deny and Close end it with `access_denied`.

**Files:**
- Modify: `apps/auth/src/views.ts`
- Modify: `apps/auth/src/interactions.ts` (replaced whole)
- Modify: `apps/auth/src/provider.ts`
- Test: `apps/auth/test/mcp-consent.test.ts`, `apps/auth/test/views.test.ts`

**Interfaces:**
- Consumes: `ConsentApi`, `ConsentRequest`, `consentAsserter`, `httpConsentApi` (Task 7); `findPaddock` (Task 6); `isCimdClient` (Task 5); `parseMcpResource`, `mcpResource` (Task 1); `CIMD_CLIENT_ID`, `CIMD_REDIRECT_URI`, `cimdDocument`, `DATA_PLANE_URL`, `startTestOp({ cimdDocuments, providerOptions })` (Task 5).
- Produces:
  - `interface ConsentView { uid; clientName; clientHost; redirectHost; paddockName; paddockSlug; email; switchAccountHref }`; `renderConsentPage(v: ConsentView): string`; `renderConsentRefusedPage(v: { uid; reason; email; switchAccountHref }): string`.
  - `InteractionDeps.consentApi: ConsentApi`, `InteractionDeps.dataPlaneUrl: string`.
  - Route: `POST /interaction/:uid/consent` with form field `decision` = `approve` | `deny` | `close`.
  - `ProviderOptions.consentApi?: ConsentApi` (defaults to `httpConsentApi` over `cfg.controlPlaneInternalUrl`).

- [ ] **Step 1: Write the failing view test**

Append to `apps/auth/test/views.test.ts` (add `renderConsentPage, renderConsentRefusedPage` to its `../src/views.js` import):

```ts
describe('the consent screen (M4 §4.3)', () => {
  const view = {
    uid: 'uid-1', clientName: 'Claude <script>', clientHost: 'claude.ai', redirectHost: 'claude.ai',
    paddockName: 'Small models', paddockSlug: 'small', email: 'm@x.io', switchAccountHref: '/auth?a=1&prompt=login+consent',
  }

  test('names the client, sets its client_id host in bold, and shows the redirect host, paddock and user', () => {
    const html = renderConsentPage(view)
    expect(html).toContain('Claude &lt;script&gt;')
    expect(html).toContain('<strong>claude.ai</strong>')
    expect(html).toContain('Small models')
    expect(html).toContain('(small)')
    expect(html).toContain('m@x.io')
    expect(html).toContain('href="/auth?a=1&amp;prompt=login+consent"')
    expect(html).toContain('action="/interaction/uid-1/consent"')
    expect(html).toContain('value="approve"')
    expect(html).toContain('value="deny"')
    expect(html).not.toContain('<script')
    expect(html).not.toMatch(/<img/)
  })

  test('the refusal shows the reason and only a Close button', () => {
    const html = renderConsentRefusedPage({ uid: 'uid-1', reason: 'Your role cannot approve apps.', email: 'v@x.io', switchAccountHref: '/auth?x=1' })
    expect(html).toContain('Your role cannot approve apps.')
    expect(html).toContain('value="close"')
    expect(html).not.toContain('value="approve"')
    expect(html.match(/<button/g)).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Write the failing flow test**

Create `apps/auth/test/mcp-consent.test.ts`:

```ts
import { afterEach, describe, expect, test } from 'vitest'
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { jwtVerify } from 'jose'
import * as schema from '@metamodels/schema'
import { mcpResource } from '@metamodels/schema'
import type { ConsentApi, ConsentRequest, Preflight } from '../src/consent-api.js'
import { seedUser, type TestDb } from './helpers/db.js'
import {
  authorize, CIMD_CLIENT_ID, CIMD_REDIRECT_URI, cimdDocument, DATA_PLANE_URL, opJwks, send, startTestOp, type TestOp,
} from './helpers/flow.js'

const T = 30_000
const EMAIL = 'member@x.io'
const PASSWORD = 'hunter2hunter2'
const RESOURCE = mcpResource(DATA_PLANE_URL, 'small')
let op: TestOp | undefined
afterEach(async () => { await op?.close(); op = undefined })

/**
 * A stand-in for the control plane's internal routes. `mint` writes the key row the control plane
 * would, so the OP's `extraTokenClaims` finds it exactly as in production.
 */
function fakeControlPlane(opts: { preflight?: Preflight; mint?: 'ok' | 'denied' | 'error' } = {}) {
  const held: { db?: TestDb } = {}
  const calls = { preflight: [] as ConsentRequest[], mint: [] as Array<ConsentRequest & { grantId: string }> }
  const api: ConsentApi = {
    async preflight(r) {
      calls.preflight.push(r)
      return opts.preflight ?? { allowed: true }
    },
    async mint(r) {
      calls.mint.push(r)
      if (opts.mint === 'denied') return { ok: false, kind: 'denied', reason: 'Your role cannot approve apps.' }
      if (opts.mint === 'error') return { ok: false, kind: 'error', detail: 'control plane down' }
      const db = held.db!
      const [u] = await db.select().from(schema.user).where(eq(schema.user.id, r.accountId))
      const [p] = await db.select().from(schema.paddock).where(eq(schema.paddock.slug, 'small'))
      const [k] = await db.insert(schema.apiKey).values({
        orgId: u.orgId, name: 'k', prefix: 'oauth', hash: randomBytes(32).toString('hex'),
        kind: 'oauth', grantId: r.grantId, oauthClientId: r.clientId, userId: u.id,
      }).returning()
      await db.insert(schema.keyPaddock).values({ keyId: k.id, paddockId: p.id })
      return { ok: true, keyId: k.id }
    },
  }
  return { api, calls, held }
}

async function setup(cp: ReturnType<typeof fakeControlPlane>, role = 'member') {
  op = await startTestOp({ cimdDocuments: { [CIMD_CLIENT_ID]: cimdDocument() }, providerOptions: { consentApi: cp.api } })
  cp.held.db = op.db
  const userId = await seedUser(op.db, { email: EMAIL, password: PASSWORD, role })
  const [u] = await op.db.select().from(schema.user).where(eq(schema.user.id, userId))
  const [f] = await op.db.insert(schema.flock).values({ orgId: u.orgId, breed: 'ollama', name: 'f', baseUrl: 'http://f' }).returning()
  await op.db.insert(schema.paddock).values({ orgId: u.orgId, flockId: f.id, slug: 'small', name: 'Small models' })
  return { userId }
}

/** Sign in as the MCP client's user and stop at the consent screen. */
async function consentPage() {
  const out = await authorize(op!, {
    email: EMAIL, password: PASSWORD, clientId: CIMD_CLIENT_ID, redirectUri: CIMD_REDIRECT_URI,
    // What a real MCP client sends: no offline_access and no prompt=consent (ruling R4).
    scope: 'openid mcp', extra: { resource: RESOURCE },
  })
  if (out.kind !== 'page') throw new Error(`expected the consent screen, got a redirect to ${out.url.href}`)
  const uid = /action="\/interaction\/([^/"]+)\/consent"/.exec(out.body)?.[1]
  if (!uid) throw new Error(`no consent form on the page: ${out.body.slice(0, 400)}`)
  return { ...out, uid }
}

/** Post a decision and follow the redirects back to the client. */
async function decide(page: Awaited<ReturnType<typeof consentPage>>, decision: 'approve' | 'deny' | 'close'): Promise<URL> {
  let res = await send(page.jar, `${op!.issuer}/interaction/${page.uid}/consent`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `decision=${decision}`,
  })
  for (let hop = 0; hop < 8; hop++) {
    if (res.status < 300 || res.status >= 400) throw new Error(`expected a redirect, got ${res.status}: ${(await res.text()).slice(0, 300)}`)
    const next = new URL(res.headers.get('location')!, op!.issuer)
    if (next.href.startsWith(CIMD_REDIRECT_URI)) return next
    res = await send(page.jar, next.href)
  }
  throw new Error('too many redirects')
}

async function tokenRequest(fields: Record<string, string>) {
  const res = await fetch(`${op!.issuer}/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CIMD_CLIENT_ID, resource: RESOURCE, ...fields }).toString(),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

const grants = async () => op!.db.select().from(schema.oidcPayload).where(eq(schema.oidcPayload.model, 'Grant'))

describe('MCP consent (M4 §4.3)', () => {
  test('the screen shows the client, its host, the redirect host, the paddock and the user; preflight comes first', async () => {
    const cp = fakeControlPlane()
    const { userId } = await setup(cp)
    const page = await consentPage()
    expect(page.status).toBe(200)
    expect(page.body).toContain('Test MCP client')
    expect(page.body).toContain('<strong>mcp-client.example.test</strong>')
    expect(page.body).toContain('127.0.0.1:43210')
    expect(page.body).toContain('Small models')
    expect(page.body).toContain(EMAIL)
    expect(page.body).toContain('prompt=login+consent')
    expect(cp.calls.preflight).toEqual([{ accountId: userId, clientId: CIMD_CLIENT_ID, clientName: 'Test MCP client', resource: RESOURCE }])
    expect(cp.calls.mint).toEqual([])
  }, T)

  test('Approve mints, then grants: a code, then a 15-minute mcp token naming the key, and a refresh token without offline_access', async () => {
    const cp = fakeControlPlane()
    await setup(cp)
    const page = await consentPage()
    const back = await decide(page, 'approve')
    const code = back.searchParams.get('code')
    expect(code, back.href).toBeTruthy()
    expect(cp.calls.mint).toHaveLength(1)
    expect((await grants()).map((g) => g.id)).toEqual([cp.calls.mint[0]!.grantId])

    const token = await tokenRequest({
      grant_type: 'authorization_code', code: code!, redirect_uri: CIMD_REDIRECT_URI, code_verifier: page.verifier,
    })
    expect(token.status, JSON.stringify(token.json)).toBe(200)
    const { payload } = await jwtVerify(token.json.access_token as string, await opJwks(op!), {
      issuer: op!.issuer, audience: RESOURCE, typ: 'at+jwt', algorithms: ['RS256'],
    })
    const [key] = await op!.db.select().from(schema.apiKey)
    expect(payload).toMatchObject({ aud: RESOURCE, scope: 'mcp', client_id: CIMD_CLIENT_ID, mm_kid: key!.id })
    expect(payload.exp! - payload.iat!).toBe(15 * 60)
    // Ruling R4: the request carried neither offline_access nor prompt=consent, as real MCP clients do.
    expect(typeof token.json.refresh_token).toBe('string')
    expect(String(token.json.scope).split(' ')).not.toContain('offline_access')
  }, T)

  test('the refresh token outlives the approving browser\'s OP session (R4: not session-bound)', async () => {
    const cp = fakeControlPlane()
    await setup(cp)
    const page = await consentPage()
    const code = (await decide(page, 'approve')).searchParams.get('code')!
    const first = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: CIMD_REDIRECT_URI, code_verifier: page.verifier })
    // End every OP session, as signing out or the 12-hour expiry would.
    await op!.db.delete(schema.oidcPayload).where(eq(schema.oidcPayload.model, 'Session'))
    const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: first.json.refresh_token as string })
    expect(refreshed.status, JSON.stringify(refreshed.json)).toBe(200)
    expect(typeof refreshed.json.access_token).toBe('string')
  }, T)

  test('a revoked key cannot be refreshed back to life: invalid_grant', async () => {
    const cp = fakeControlPlane()
    await setup(cp)
    const page = await consentPage()
    const code = (await decide(page, 'approve')).searchParams.get('code')!
    const first = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: CIMD_REDIRECT_URI, code_verifier: page.verifier })
    await op!.db.update(schema.apiKey).set({ status: 'revoked' })
    const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: first.json.refresh_token as string })
    expect(refreshed.status).toBe(400)
    expect(refreshed.json.error).toBe('invalid_grant')
  }, T)

  test('Deny ends with access_denied, mints nothing and saves no grant', async () => {
    const cp = fakeControlPlane()
    await setup(cp)
    const back = await decide(await consentPage(), 'deny')
    expect(back.searchParams.get('error')).toBe('access_denied')
    expect(back.searchParams.get('code')).toBeNull()
    expect(cp.calls.mint).toEqual([])
    expect(await grants()).toEqual([])
  }, T)

  test('a viewer sees the refusal and only Close; Close ends with access_denied and the reason', async () => {
    const reason = 'Your role cannot approve apps. Ask an admin or a member of your organization to connect this one.'
    const cp = fakeControlPlane({ preflight: { allowed: false, reason } })
    await setup(cp, 'viewer')
    const page = await consentPage()
    expect(page.body).toContain(reason)
    expect(page.body).not.toContain('value="approve"')
    const back = await decide(page, 'close')
    expect(back.searchParams.get('error')).toBe('access_denied')
    expect(back.searchParams.get('error_description')).toBe(reason)
    expect(cp.calls.mint).toEqual([])
    expect(await grants()).toEqual([])
  }, T)

  test('a mint that fails ends with server_error and no grant, so no grant exists without a key', async () => {
    const cp = fakeControlPlane({ mint: 'error' })
    await setup(cp)
    const back = await decide(await consentPage(), 'approve')
    expect(back.searchParams.get('error')).toBe('server_error')
    expect(await grants()).toEqual([])
    expect(await op!.db.select().from(schema.apiKey)).toEqual([])
  }, T)

  test('a mint refused after a yes from preflight ends with access_denied and the reason', async () => {
    const cp = fakeControlPlane({ mint: 'denied' })
    await setup(cp)
    const back = await decide(await consentPage(), 'approve')
    expect(back.searchParams.get('error')).toBe('access_denied')
    expect(back.searchParams.get('error_description')).toBe('Your role cannot approve apps.')
    expect(await grants()).toEqual([])
  }, T)

  test('a CIMD client asking for no MCP resource is still refused at consent, as in M1', async () => {
    const cp = fakeControlPlane()
    await setup(cp)
    const out = await authorize(op!, {
      email: EMAIL, password: PASSWORD, clientId: CIMD_CLIENT_ID, redirectUri: CIMD_REDIRECT_URI, scope: 'openid',
    })
    if (out.kind !== 'redirect') throw new Error(`expected an error redirect, got the page ${out.body.slice(0, 200)}`)
    expect(out.url.searchParams.get('error')).toBe('access_denied')
    expect(cp.calls.preflight).toEqual([])
  }, T)
})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm exec vitest run apps/auth/test/mcp-consent.test.ts apps/auth/test/views.test.ts`
Expected: FAIL — `renderConsentPage` is not exported, and the flow ends in `access_denied` at consent (the M1 branch).

- [ ] **Step 4: Add the views**

Append to `apps/auth/src/views.ts`:

```ts
export interface ConsentView {
  uid: string
  /** Self-asserted by the client's metadata document. */
  clientName: string
  /** The host of the client_id URL: the identity a user can actually check. */
  clientHost: string
  redirectHost: string
  paddockName: string
  paddockSlug: string
  email: string
  /** Restarts this authorization request with `prompt=login consent`, so another account can approve. */
  switchAccountHref: string
}

function signedInAs(email: string, switchAccountHref: string): string {
  return `<p class="device">Signed in as <strong>${escapeHtml(email)}</strong>. <a href="${escapeHtml(switchAccountHref)}">Use another account</a></p>`
}

/**
 * The MCP consent screen (M4 §4.3). Same shell and static CSP as every page here, so no script, and
 * no client logo: `img-src` stays `'self'`. The client's name is its own claim; the bold host is the
 * part a user can verify, so the page says which is which.
 */
export function renderConsentPage(v: ConsentView): string {
  return page('Approve app', `<h1>Connect an app to MetaModels?</h1>
<p><strong>${escapeHtml(v.clientName)}</strong> from <strong>${escapeHtml(v.clientHost)}</strong> wants to use the paddock <strong>${escapeHtml(v.paddockName)}</strong> (${escapeHtml(v.paddockSlug)}) as you.</p>
<p class="device">The app chose its own name. <strong>${escapeHtml(v.clientHost)}</strong> is what identifies it: approve only if you recognize it and you started this connection yourself.</p>
<p class="device">After you approve, your browser returns to <strong>${escapeHtml(v.redirectHost)}</strong>.</p>
${signedInAs(v.email, v.switchAccountHref)}
<form method="post" action="/interaction/${encodeURIComponent(v.uid)}/consent">
<button autofocus type="submit" name="decision" value="approve">Approve</button>
<button class="secondary" type="submit" name="decision" value="deny">Deny</button>
</form>`)
}

/** Preflight said no (a viewer, or a paddock the user cannot see): the reason, and only Close. */
export function renderConsentRefusedPage(v: { uid: string; reason: string; email: string; switchAccountHref: string }): string {
  return page('Cannot approve', `<h1>You cannot approve this app</h1>
<p class="error" role="alert">${escapeHtml(v.reason)}</p>
${signedInAs(v.email, v.switchAccountHref)}
<form method="post" action="/interaction/${encodeURIComponent(v.uid)}/consent">
<button type="submit" name="decision" value="close">Close</button>
</form>`)
}
```

- [ ] **Step 5: Replace the interaction handler**

Replace `apps/auth/src/interactions.ts` entirely. `interactionPolicyWithFreshDeviceLogin`, `loadExistingGrant`, `submitLogin` and `readForm` are unchanged from the current file; `consentFor`'s scope bookkeeping moves into `addMissing` so both consent paths share it.

```ts
import { randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { eq } from 'drizzle-orm'
import type { Middleware, ParameterizedContext } from 'koa'
import type Provider from 'oidc-provider'
import type { Grant, InteractionResults, KoaContextWithOIDC } from 'oidc-provider'
import { errors, interactionPolicy } from 'oidc-provider'
import { parseMcpResource, user } from '@metamodels/schema'
import { verifyLogin } from './account.js'
import { isCimdClient } from './cimd.js'
import type { ConsentApi, ConsentRequest } from './consent-api.js'
import type { Db } from './db.js'
import type { LoginThrottle } from './login-throttle.js'
import { findPaddock } from './paddocks.js'
import {
  AUTH_CSS, renderConsentPage, renderConsentRefusedPage, renderLoginPage, renderMessagePage, type ConsentView,
} from './views.js'

type Ctx = ParameterizedContext
type InteractionDetails = Awaited<ReturnType<Provider['interactionDetails']>>

export interface InteractionDeps {
  provider: Provider
  db: Db
  throttle: LoginThrottle
  /** Clients that ARE MetaModels, so consent is implied. */
  firstPartyClientIds: ReadonlySet<string>
  csp: string
  /** The control plane's internal oauth-keys routes (M4 D7). */
  consentApi: ConsentApi
  /** `DATA_PLANE_URL`, to recognise an MCP resource indicator. */
  dataPlaneUrl: string
}

/** What a client that is neither first-party nor a CIMD client asking for one MCP resource is told (M1). */
const NOT_PERMITTED = 'This client is not permitted to sign in yet.'

/** oidc-provider's route names for the browser half of the device grant: the confirm POST, and resuming after an interaction. */
const DEVICE_APPROVAL_ROUTES: ReadonlySet<string> = new Set(['code_verification', 'device_resume'])

/**
 * oidc-provider's default interaction policy plus one login check: approving a device requires a
 * password typed in THIS interaction (RFC 8628 §5.4, remote phishing). An existing OP session does
 * not count, however recent.
 *
 * `ctx.oidc.result` is the result of the interaction being resumed, and exists only on a resume
 * route. On the confirm POST (`code_verification`) there is none, so the login prompt always
 * fires. On `device_resume` it is what our handlers submitted for this interaction: `login` is
 * present only if the login form was submitted here (the consent step keeps it, since it merges
 * with the last submission). A login in another tab is a different interaction and leaves no
 * `result.login` here. oidc-provider's own `max_age` check uses the same test.
 *
 * Every other route (the console's authorization-code flow) skips the check, so its login
 * behaves as before.
 */
export function interactionPolicyWithFreshDeviceLogin(): interactionPolicy.DefaultPolicy {
  const { Check, base } = interactionPolicy
  const policy = base()
  policy.get('login')!.checks.add(new Check(
    'device_fresh_login',
    'approving a device requires the password',
    (ctx) => DEVICE_APPROVAL_ROUTES.has(ctx.oidc.route) && !ctx.oidc.result?.login
      ? Check.REQUEST_PROMPT
      : Check.NO_NEED_TO_PROMPT,
  ))
  return policy
}

/**
 * `loadExistingGrant`: which grant an authorization request starts from. oidc-provider's default
 * takes the grant the consent step just handed back (`result.consent.grantId`), and failing that
 * the one the browser session already holds for the client (`session.grantIdFor(clientId)`).
 *
 * A device approval (`DEVICE_APPROVAL_ROUTES`) skips the session's grant, so every approval starts
 * from an empty grant: the consent prompt then lists every scope the device asked for, and
 * `consentFor` saves them in a new grant. One grant per approval is this project's decision, not
 * something RFC 8628 asks for: revoking a refresh token revokes its grant, so a grant shared by
 * every machine approved in one browser would let signing one machine out sign them all out. The
 * consent step's own grant is still taken: oidc-provider then records it as the session's
 * grant for the client, and binds the device code to that. The session so points at the newest
 * device grant. An older one is not revoked; it lives on for the refresh tokens issued under it.
 *
 * Every other route (the console's authorization-code flow, and MCP clients) keeps the default. An
 * MCP client's second paddock therefore extends the session's grant; its oauth keys are found per
 * (grant, paddock), never by the grant alone (`activeOauthKeyForGrant`).
 */
export async function loadExistingGrant(ctx: KoaContextWithOIDC): Promise<Grant | undefined> {
  const grantId = ctx.oidc.result?.consent?.grantId
    || (DEVICE_APPROVAL_ROUTES.has(ctx.oidc.route) ? undefined : ctx.oidc.session!.grantIdFor(ctx.oidc.client!.clientId))
  return grantId ? ctx.oidc.provider.Grant.find(grantId) : undefined
}

const INTERACTION_PATH = /^\/interaction\/([A-Za-z0-9_-]+)(\/login|\/consent)?$/
const MAX_FORM_BYTES = 16 * 1024

function html(ctx: Ctx, status: number, body: string): void {
  ctx.status = status
  ctx.type = 'html'
  ctx.body = body
}

/**
 * Registered with `provider.use()`, so it runs before oidc-provider's own routes. Sets security
 * headers on EVERY response, serves the health check and stylesheet, and owns /interaction/*.
 * Everything else falls through to oidc-provider.
 */
export function interactionMiddleware(deps: InteractionDeps): Middleware {
  return async (ctx, next) => {
    ctx.set('Content-Security-Policy', deps.csp)
    ctx.set('X-Content-Type-Options', 'nosniff')
    ctx.set('X-Frame-Options', 'DENY')
    ctx.set('Referrer-Policy', 'no-referrer')
    // Inert over plain HTTP; takes effect once TLS terminates in front of the service.
    ctx.set('Strict-Transport-Security', 'max-age=63072000')

    if (ctx.method === 'GET' && ctx.path === '/healthz') {
      ctx.body = { ok: true }
      return
    }
    if (ctx.method === 'GET' && ctx.path === '/assets/auth.css') {
      ctx.type = 'text/css'
      ctx.set('Cache-Control', 'public, max-age=3600')
      ctx.body = AUTH_CSS
      return
    }

    const match = INTERACTION_PATH.exec(ctx.path)
    if (!match) return next()
    ctx.set('Cache-Control', 'no-store')
    try {
      if (ctx.method === 'GET' && !match[2]) return await showInteraction(ctx, deps)
      if (ctx.method === 'POST' && match[2] === '/login') return await submitLogin(ctx, deps)
      if (ctx.method === 'POST' && match[2] === '/consent') return await submitConsent(ctx, deps)
      ctx.status = 405
      ctx.set('Allow', match[2] ? 'POST' : 'GET')
    } catch (err) {
      if (err instanceof errors.SessionNotFound) {
        html(ctx, 400, renderMessagePage(
          'Sign-in expired',
          'This sign-in attempt has expired or was already completed. Start the sign-in again from the console or your terminal.',
        ))
        return
      }
      throw err
    }
  }
}

async function showInteraction(ctx: Ctx, deps: InteractionDeps): Promise<void> {
  const details = await deps.provider.interactionDetails(ctx.req, ctx.res)
  const { uid, prompt, params } = details

  if (prompt.name === 'login') {
    const hint = typeof params.login_hint === 'string' ? params.login_hint : undefined
    html(ctx, 200, renderLoginPage({ uid, email: hint }))
    return
  }

  if (prompt.name === 'consent') {
    if (deps.firstPartyClientIds.has(String(params.client_id))) {
      const consent = await consentFor(deps.provider, details)
      await deps.provider.interactionFinished(ctx.req, ctx.res, { consent }, { mergeWithLastSubmission: true })
      return
    }
    const mcp = await mcpConsent(deps, details)
    if (!mcp) {
      await deps.provider.interactionFinished(ctx.req, ctx.res, {
        error: 'access_denied', error_description: NOT_PERMITTED,
      }, { mergeWithLastSubmission: false })
      return
    }
    // Asked before the page renders (spec §3.3), so a viewer never sees a button that would fail.
    const pre = await deps.consentApi.preflight(mcp.request)
    html(ctx, 200, pre.allowed
      ? renderConsentPage({ uid, ...mcp.view })
      : renderConsentRefusedPage({ uid, reason: pre.reason, email: mcp.view.email, switchAccountHref: mcp.view.switchAccountHref }))
    return
  }

  html(ctx, 400, renderMessagePage('Unsupported request', `This sign-in step (${prompt.name}) is not supported.`))
}

interface McpConsent {
  request: ConsentRequest
  view: Omit<ConsentView, 'uid'>
}

/** The one resource an MCP authorization request names, or null for none or several. */
function singleResource(v: unknown): string | null {
  if (typeof v === 'string') return v
  if (Array.isArray(v) && v.length === 1 && typeof v[0] === 'string') return v[0]
  return null
}

/**
 * This same authorization request with `prompt=login consent`: a fresh password prompt, after which
 * `switchAccountMiddleware` handles the account change on `resume` exactly as for the console, and
 * the consent screen comes back for the account that signed in. `consent` stays in the prompt so the
 * screen is shown even when the new account's grant already covers the request.
 */
function switchAccountHref(params: Record<string, unknown>): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (typeof v === 'string' && k !== 'prompt') q.set(k, v)
  q.set('prompt', 'login consent')
  return `/auth?${q}`
}

/**
 * The consent context when this interaction is a CIMD client asking for exactly one MCP resource of
 * an active paddock; null for anything else (which M1's refusal then answers). Everything shown is
 * re-read here: the client from its document (cached by oidc-provider), the paddock and the user's
 * email from the database.
 */
async function mcpConsent(deps: InteractionDeps, details: InteractionDetails): Promise<McpConsent | null> {
  const client = await deps.provider.Client.find(String(details.params.client_id)).catch(() => undefined)
  if (!client || !isCimdClient(client)) return null
  const resource = singleResource(details.params.resource)
  const slug = resource === null ? null : parseMcpResource(deps.dataPlaneUrl, resource)
  if (resource === null || slug === null) return null
  const paddock = await findPaddock(deps.db, slug)
  if (!paddock || paddock.status !== 'active') return null

  const accountId = details.session?.accountId
  if (!accountId) throw new Error('consent prompt reached without an authenticated session')
  const rows = await deps.db.select({ email: user.email }).from(user).where(eq(user.id, accountId)).limit(1)

  const clientHost = new URL(client.clientId).host
  const clientName = client.clientName ?? clientHost
  return {
    request: { accountId, clientId: client.clientId, clientName, resource },
    view: {
      clientName,
      clientHost,
      redirectHost: new URL(String(details.params.redirect_uri)).host,
      paddockName: paddock.name,
      paddockSlug: paddock.slug,
      email: rows[0]?.email ?? '',
      switchAccountHref: switchAccountHref(details.params),
    },
  }
}

/**
 * Approve, Deny or Close on the consent screen. Approve: mint first, then save the grant, so a grant
 * never exists without its key (spec §3.5). The grant id is chosen here, before the mint, because the
 * key is bound to it; an existing session grant keeps its id and gains the resource scope.
 */
async function submitConsent(ctx: Ctx, deps: InteractionDeps): Promise<void> {
  const details = await deps.provider.interactionDetails(ctx.req, ctx.res)
  if (details.prompt.name !== 'consent') {
    html(ctx, 400, renderMessagePage('Unsupported request', 'This sign-in step does not take an approval.'))
    return
  }
  const form = await readForm(ctx.req)
  if (form === null) {
    html(ctx, 413, renderMessagePage('Request too large', 'The approval form submission was too large.'))
    return
  }
  const fail = (result: InteractionResults) =>
    deps.provider.interactionFinished(ctx.req, ctx.res, result, { mergeWithLastSubmission: false })

  const mcp = await mcpConsent(deps, details)
  if (!mcp) return void await fail({ error: 'access_denied', error_description: NOT_PERMITTED })

  const decision = form.get('decision')
  if (decision !== 'approve') {
    // Close follows a refusal: tell the client the same reason the user was shown.
    const pre = decision === 'close' ? await deps.consentApi.preflight(mcp.request) : undefined
    return void await fail({
      error: 'access_denied',
      error_description: pre && !pre.allowed ? pre.reason : 'The request was denied.',
    })
  }

  const existing = details.grantId ? await deps.provider.Grant.find(details.grantId) : undefined
  const grant = existing ?? new deps.provider.Grant({ accountId: mcp.request.accountId, clientId: mcp.request.clientId })
  if (!existing) grant.jti = randomBytes(16).toString('base64url')

  const minted = await deps.consentApi.mint({ ...mcp.request, grantId: grant.jti })
  if (!minted.ok) {
    if (minted.kind === 'error') {
      // eslint-disable-next-line no-console
      console.error(`[auth] recording an MCP approval failed: ${minted.detail}`)
      return void await fail({ error: 'server_error', error_description: 'MetaModels could not record this approval, so nothing was granted. Try again.' })
    }
    return void await fail({ error: 'access_denied', error_description: minted.reason })
  }

  addMissing(grant, details)
  await grant.save()
  await deps.provider.interactionFinished(ctx.req, ctx.res, {
    consent: existing ? {} : { grantId: grant.jti },
  }, { mergeWithLastSubmission: true })
}

/** Grant exactly what the request is missing, and nothing more: oidc-provider's reference handler, minus the screen. */
function addMissing(grant: Grant, details: InteractionDetails): void {
  const missing = details.prompt.details as {
    missingOIDCScope?: string[]
    missingOIDCClaims?: string[]
    missingResourceScopes?: Record<string, string[]>
  }
  if (missing.missingOIDCScope) grant.addOIDCScope(missing.missingOIDCScope.join(' '))
  if (missing.missingOIDCClaims) grant.addOIDCClaims(missing.missingOIDCClaims)
  for (const [resource, scopes] of Object.entries(missing.missingResourceScopes ?? {})) {
    grant.addResourceScope(resource, scopes.join(' '))
  }
}

/**
 * Automatic consent for a first-party client: grant exactly what this request is missing, and
 * nothing more. Mirrors oidc-provider's reference consent handler, minus the screen.
 *
 * Which grant it writes to is decided by `details.grantId`, the saved grant the request started
 * from (see `loadExistingGrant`):
 * - Set (the console's authorization-code flow, when its browser session already holds a grant for
 *   the client): the missing scopes are added to that grant in place, and nothing is handed back.
 * - Unset: a NEW grant is saved and its id handed back, and the provider binds the request to it.
 *   Every device approval takes this branch: `loadExistingGrant` starts it from an unsaved grant,
 *   so it never carries the session's grant here, and the missing scopes are all it asked for.
 *   A device approval that did carry one is refused rather than given a shared grant.
 */
async function consentFor(provider: Provider, details: InteractionDetails): Promise<{ grantId?: string }> {
  const accountId = details.session?.accountId
  if (!accountId) throw new Error('consent prompt reached without an authenticated session')
  if (details.deviceCode !== undefined && details.grantId !== undefined) {
    throw new Error('device approval reached consent with an existing grant; each device gets its own')
  }

  const existing = details.grantId ? await provider.Grant.find(details.grantId) : undefined
  const grant = existing ?? new provider.Grant({ accountId, clientId: String(details.params.client_id) })
  addMissing(grant, details)
  const grantId = await grant.save()
  // An existing grant is modified in place; only a new one is handed back to the provider.
  return details.grantId ? {} : { grantId }
}

async function submitLogin(ctx: Ctx, deps: InteractionDeps): Promise<void> {
  const details = await deps.provider.interactionDetails(ctx.req, ctx.res)
  if (details.prompt.name !== 'login') {
    html(ctx, 400, renderMessagePage('Unsupported request', 'This sign-in step does not accept a password.'))
    return
  }

  const form = await readForm(ctx.req)
  if (form === null) {
    html(ctx, 413, renderMessagePage('Request too large', 'The sign-in form submission was too large.'))
    return
  }
  const email = (form.get('email') ?? '').trim()
  const password = form.get('password') ?? ''
  // provider.proxy = true, so ctx.ip is the first X-Forwarded-For hop — the throttle is only
  // meaningful behind a trusted proxy (docs/DEPLOY.md, "Deploy gotchas"), exactly as it was in the console.
  const ip = ctx.ip || 'unknown'
  const now = Date.now()

  if (!deps.throttle.check(ip, now)) {
    html(ctx, 429, renderLoginPage({ uid: details.uid, email, error: 'Too many attempts. Try again later.' }))
    return
  }
  const result = await verifyLogin(deps.db, email, password)
  if (!result.ok) {
    deps.throttle.record(ip, now)
    const error = result.reason === 'deactivated' ? 'This account is deactivated.' : 'Invalid email or password.'
    html(ctx, 401, renderLoginPage({ uid: details.uid, email, error }))
    return
  }
  await deps.provider.interactionFinished(ctx.req, ctx.res, {
    login: { accountId: result.accountId },
  }, { mergeWithLastSubmission: false })
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > MAX_FORM_BYTES) return null
    chunks.push(buf)
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}
```

- [ ] **Step 6: Hand the provider its consent API**

In `apps/auth/src/provider.ts`:
- import `{ consentAsserter, httpConsentApi, type ConsentApi }` from `./consent-api.js`;
- add to `ProviderOptions`:

```ts
  /** The control plane's oauth-keys routes. Defaults to HTTP over `cfg.controlPlaneInternalUrl`; tests inject a fake. */
  consentApi?: ConsentApi
```

- compute the key set once, before `configuration`, and build the default consent API from its signer:

```ts
  const jwks = signingJwks(cfg.signingKeyPem, cfg.allowEphemeralKey, cfg.previousSigningKeyPems)
  const consentApi = opts.consentApi ?? httpConsentApi({
    baseUrl: cfg.controlPlaneInternalUrl,
    // The first key is the one oidc-provider signs with (see `signingJwks`); the control plane
    // verifies the assertion against the same published JWKS.
    assert: consentAsserter({ issuer: cfg.issuer, consoleUrl: cfg.consoleUrl, signingJwk: jwks.keys[0]! }),
  })
```

- change `jwks: signingJwks(…)` in `configuration` to `jwks,`;
- pass the two new deps to `interactionMiddleware({ …, consentApi, dataPlaneUrl: cfg.dataPlaneUrl })`, and update the `firstPartyClientIds` comment to: *"Auto-consented without a consent screen (spec A16). Every other client is refused at consent, except a CIMD client asking for one MCP resource, which gets the consent screen (M4 §4.3)."*

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm exec vitest run apps/auth/test/mcp-consent.test.ts apps/auth/test/views.test.ts apps/auth/test/provider.test.ts`
Expected: PASS — including M1's `'a third-party client is refused at consent instead of being silently granted'`.

- [ ] **Step 8: Run the auth suite and typecheck**

Run: `pnpm exec vitest run apps/auth && pnpm -w exec tsc -b`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/auth/src apps/auth/test
git commit -m "feat(auth): an MCP consent screen that mints the oauth key before it saves the grant"
```

---

### Task 9: `form-action` follows a CIMD client's redirect

Spec §3.6 (D5). The OP's CSP lists only the console as a `form-action` target, and Chrome enforces `form-action` across the redirects that follow a form POST — the policy that counts is the one on the page holding the form. Every HTML page of a CIMD client's interaction (the login page, the consent screen, the refusal, the switch-account page on `resume`) must therefore list that client's validated `redirect_uri` origin. Every other response keeps the static policy.

**Files:**
- Create: `apps/auth/src/cimd-csp.ts`
- Modify: `apps/auth/src/provider.ts`
- Test: `apps/auth/test/cimd-csp.test.ts`

**Interfaces:**
- Consumes: `authCsp` (`views.ts`), `isCimdClient` (Task 5).
- Produces: `cimdCspMiddleware(opts: { provider: Provider; consoleOrigin: string }): Middleware`.

- [ ] **Step 1: Write the failing test**

Create `apps/auth/test/cimd-csp.test.ts`:

```ts
import { afterEach, describe, expect, test } from 'vitest'
import { mcpResource } from '@metamodels/schema'
import { authCsp } from '../src/views.js'
import { seedUser } from './helpers/db.js'
import {
  authorize, CIMD_CLIENT_ID, CIMD_REDIRECT_URI, cimdDocument, CONSOLE_URL, DATA_PLANE_URL, startTestOp, type TestOp,
} from './helpers/flow.js'
import * as schema from '@metamodels/schema'
import { eq } from 'drizzle-orm'

const T = 30_000
const STATIC = authCsp([CONSOLE_URL])
const WIDENED = authCsp([CONSOLE_URL, new URL(CIMD_REDIRECT_URI).origin])
let op: TestOp | undefined
afterEach(async () => { await op?.close(); op = undefined })

async function mcpOp() {
  op = await startTestOp({
    cimdDocuments: { [CIMD_CLIENT_ID]: cimdDocument() },
    providerOptions: { consentApi: { preflight: async () => ({ allowed: true }), mint: async () => ({ ok: false, kind: 'error', detail: 'unused' }) } },
    extraClients: [{
      client_id: 'third-party', client_secret: 'third-party-secret-0123', redirect_uris: ['http://third.test/cb'],
      grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'client_secret_basic',
    }],
  })
  const userId = await seedUser(op.db, { email: 'm@x.io', password: 'hunter2hunter2', role: 'member' })
  const [u] = await op.db.select().from(schema.user).where(eq(schema.user.id, userId))
  const [f] = await op.db.insert(schema.flock).values({ orgId: u.orgId, breed: 'ollama', name: 'f', baseUrl: 'http://f' }).returning()
  await op.db.insert(schema.paddock).values({ orgId: u.orgId, flockId: f.id, slug: 'small', name: 'Small models' })
}

const mcpRequest = { clientId: CIMD_CLIENT_ID, redirectUri: CIMD_REDIRECT_URI, scope: 'openid mcp', extra: { resource: mcpResource(DATA_PLANE_URL, 'small') } }

describe('cimdCspMiddleware (M4 D5)', () => {
  test('a CIMD client\'s login page and consent screen allow form-action to its redirect origin', async () => {
    await mcpOp()
    const login = await authorize(op!, mcpRequest)
    if (login.kind !== 'page') throw new Error('expected the login page')
    expect(login.csp).toBe(WIDENED)
    const consent = await authorize(op!, { ...mcpRequest, email: 'm@x.io', password: 'hunter2hunter2' })
    if (consent.kind !== 'page') throw new Error('expected the consent screen')
    expect(consent.body).toContain('Connect an app to MetaModels?')
    expect(consent.csp).toBe(WIDENED)
    // Only form-action moved: every other directive is the static policy's.
    expect(consent.csp!.split('; ').filter((d) => !d.startsWith('form-action')))
      .toEqual(STATIC.split('; ').filter((d) => !d.startsWith('form-action')))
  }, T)

  test('the console, a static third-party client and the health check keep the static policy', async () => {
    await mcpOp()
    const consoleLogin = await authorize(op!, {})
    if (consoleLogin.kind !== 'page') throw new Error('expected the console login page')
    expect(consoleLogin.csp).toBe(STATIC)
    const thirdParty = await authorize(op!, { clientId: 'third-party', redirectUri: 'http://third.test/cb' })
    if (thirdParty.kind !== 'page') throw new Error('expected the third party\'s login page')
    expect(thirdParty.csp).toBe(STATIC)
    expect((await fetch(`${op!.issuer}/healthz`)).headers.get('content-security-policy')).toBe(STATIC)
  }, T)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run apps/auth/test/cimd-csp.test.ts`
Expected: FAIL — the CIMD pages carry `STATIC`.

- [ ] **Step 3: Implement the middleware**

Create `apps/auth/src/cimd-csp.ts`:

```ts
import type { Middleware } from 'koa'
import type Provider from 'oidc-provider'
import { isCimdClient } from './cimd.js'
import { authCsp } from './views.js'

/** The two paths whose HTML belongs to an interaction: our `/interaction/:uid…` pages, and oidc-provider's `resume` (`/auth/:uid`). */
const INTERACTION_PAGE = /^\/(?:interaction|auth)\/([A-Za-z0-9_-]+)/

/**
 * Registered with `provider.use()` BEFORE `interactionMiddleware`, so it wraps it: it runs after the
 * response is built and may rewrite its CSP. On the pattern of `switchAccountMiddleware`.
 *
 * `authCsp` is computed once, from the console origin. After a CIMD client's login or consent, the
 * browser is redirected to that client's `redirect_uri`, whose origin is in no static list; browsers
 * apply the submitting page's `form-action` to the redirects that follow, so the static header would
 * block the hand-back. For an HTML response on an interaction whose client is a CIMD client, this
 * appends that interaction's `redirect_uri` origin — validated by oidc-provider at `/auth`, and
 * re-checked against the client here — to `form-action`. Nothing else changes, on any response.
 */
export function cimdCspMiddleware(opts: { provider: Provider; consoleOrigin: string }): Middleware {
  return async (ctx, next) => {
    await next()
    if (!ctx.response.is('html')) return
    const match = INTERACTION_PAGE.exec(ctx.path)
    if (!match) return
    const interaction = await opts.provider.Interaction.find(match[1]!)
    if (!interaction) return
    const { client_id: clientId, redirect_uri: redirectUri } = interaction.params as Record<string, unknown>
    if (typeof clientId !== 'string' || typeof redirectUri !== 'string') return
    const client = await opts.provider.Client.find(clientId).catch(() => undefined)
    if (!client || !isCimdClient(client) || !client.redirectUriAllowed(redirectUri)) return
    const origin = new URL(redirectUri).origin
    if (origin === 'null') return
    ctx.set('Content-Security-Policy', authCsp([opts.consoleOrigin, origin]))
  }
}
```

In `apps/auth/src/provider.ts`, import `cimdCspMiddleware` and register it **first**, before `interactionMiddleware`:

```ts
  const consoleOrigin = new URL(cfg.consoleUrl).origin
  // First, so it wraps everything below and sees each response last.
  provider.use(cimdCspMiddleware({ provider, consoleOrigin }))
  provider.use(interactionMiddleware({
    // … as before, with `csp: authCsp([consoleOrigin])`
  }))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run apps/auth/test/cimd-csp.test.ts apps/auth/test/provider.test.ts apps/auth/test/device-views.test.ts`
Expected: PASS (M1's `health, stylesheet and security headers are served` still sees `form-action 'self' http://console.test`).

- [ ] **Step 5: Run the auth suite and typecheck**

Run: `pnpm exec vitest run apps/auth && pnpm -w exec tsc -b`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/auth/src/cimd-csp.ts apps/auth/src/provider.ts apps/auth/test/cimd-csp.test.ts
git commit -m "feat(auth): widen form-action to a CIMD client's redirect origin on its interaction pages"
```

---

### Task 10: Breed hooks `mcpCall` and `mcpResult`

Spec §3.8 (D8). M3 gave each breed `toMcp(fence)` but no way to execute a tool. Two optional hooks translate one `tools/call` into the request the proxy would have received (pure, no I/O) and shape the proxy's answer as MCP content. Enforcement stays in `guard()` / `handle` — the hooks only plan. Two additions to the spec's list, both following the code: Ollama's `list_models` tool (M3 ships it, `ollama/mcp.ts:83-91`) plans `GET /api/tags`; and ComfyUI's `get_job_result` result carries image bytes only when the data plane attached them (the result route itself returns references, Task 12 fetches the bytes).

**Files:**
- Modify: `packages/connectors/src/mcp.ts`, `packages/connectors/src/breed.ts`
- Modify: `packages/connectors/src/ollama/mcp.ts`, `packages/connectors/src/ollama/breed.ts`, `packages/connectors/src/ollama/index.ts`
- Modify: `packages/connectors/src/comfyui/mcp.ts`, `packages/connectors/src/comfyui/breed.ts`, `packages/connectors/src/comfyui/index.ts`
- Test: `packages/connectors/test/ollama-mcp-call.test.ts`, `packages/connectors/test/comfyui-mcp-call.test.ts`

**Interfaces:**
- Consumes: `ollamaToMcp`, `routeGroup`, `comfyToolNames`, `JOB_RESULT_TOOL` (M3).
- Produces (all exported from `@metamodels/connectors`):
  - `type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }`
  - `interface McpCallToolResult { content: McpContent[]; structuredContent?: Record<string, unknown>; isError?: boolean }`
  - `toolError(text: string): McpCallToolResult`
  - `interface McpPlannedRequest { method: 'GET' | 'POST'; path: string; body?: unknown }`
  - `type McpCallPlan = { ok: true; request: McpPlannedRequest } | { ok: false; error: string }`
  - `Breed.mcpCall?(name: string, args: unknown, fence: C): McpCallPlan`; `Breed.mcpResult?(name: string, result: { status: number; body: unknown }): McpCallToolResult`
  - `ollamaMcpCall`, `ollamaMcpResult`, `comfyMcpCall`, `comfyMcpResult`
  - `interface JobResultImage { filename: string; subfolder: string; type: string; data?: string; mimeType?: string }`

- [ ] **Step 1: Write the failing Ollama tests**

Create `packages/connectors/test/ollama-mcp-call.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { ollamaBreed, ollamaConstraint, ollamaMcpCall, ollamaMcpResult, ollamaToMcp, routeGroup } from '../src/index.js'

const fence = ollamaConstraint.parse({ allowedRoutes: ['chat', 'generate', 'embed', 'read'], allowedModels: ['llama3.2:1b'] })
const messages = [{ role: 'user', content: 'hi' }]

describe('ollamaMcpCall (M4 D8)', () => {
  test('chat, generate and embed plan the proxy route with stream: false; list_models plans GET /api/tags', () => {
    expect(ollamaMcpCall('chat', { model: 'llama3.2:1b', messages }, fence)).toEqual({
      ok: true, request: { method: 'POST', path: '/api/chat', body: { model: 'llama3.2:1b', messages, stream: false } },
    })
    expect(ollamaMcpCall('generate', { model: 'llama3.2:1b', prompt: 'p', system: 's' }, fence)).toEqual({
      ok: true, request: { method: 'POST', path: '/api/generate', body: { model: 'llama3.2:1b', prompt: 'p', system: 's', stream: false } },
    })
    expect(ollamaMcpCall('embed', { model: 'llama3.2:1b', input: ['a'] }, fence)).toEqual({
      ok: true, request: { method: 'POST', path: '/api/embed', body: { model: 'llama3.2:1b', input: ['a'] } },
    })
    expect(ollamaMcpCall('list_models', {}, fence)).toEqual({ ok: true, request: { method: 'GET', path: '/api/tags' } })
  })

  test('a caller cannot turn streaming back on, or smuggle fields the schema does not declare', () => {
    const plan = ollamaMcpCall('chat', { model: 'llama3.2:1b', messages, stream: true, keep_alive: -1, options: { num_gpu: 99 } }, fence)
    expect(plan).toEqual({ ok: true, request: { method: 'POST', path: '/api/chat', body: { model: 'llama3.2:1b', messages, stream: false } } })
  })

  test('the model is NOT checked here: guard() is the enforcement point', () => {
    const plan = ollamaMcpCall('chat', { model: 'llama3:70b', messages }, fence)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    const guard = ollamaBreed.guard({ ...plan.request, headers: {}, paddockSlug: 's' }, fence)
    expect(guard).toMatchObject({ ok: false, status: 403, reason: 'model not allowed: llama3:70b' })
  })

  test('malformed arguments and tools this fence does not list are refused', () => {
    expect(ollamaMcpCall('chat', { model: 'llama3.2:1b' }, fence)).toEqual({ ok: false, error: 'invalid arguments: messages must be a non-empty array' })
    expect(ollamaMcpCall('generate', { model: 1, prompt: 'p' }, fence)).toEqual({ ok: false, error: 'invalid arguments: model must be a string' })
    expect(ollamaMcpCall('chat', 'not an object', fence)).toEqual({ ok: false, error: 'invalid arguments: expected an object' })
    const chatOnly = ollamaConstraint.parse({ allowedRoutes: ['chat'], allowedModels: null })
    expect(ollamaMcpCall('embed', { model: 'm', input: ['a'] }, chatOnly)).toEqual({ ok: false, error: 'unknown tool: embed' })
    expect(ollamaMcpCall('pull', { name: 'x' }, fence)).toEqual({ ok: false, error: 'unknown tool: pull' })
  })

  test('no tool of any fence plans a mutate or unknown route (parent §5)', () => {
    const fences = [
      fence,
      ollamaConstraint.parse({ allowedRoutes: ['chat', 'generate', 'embed', 'read'], allowedModels: null }),
      ollamaConstraint.parse({ allowedRoutes: ['read'], allowedModels: [] }),
    ]
    const args: Record<string, unknown> = {
      chat: { model: 'm', messages }, generate: { model: 'm', prompt: 'p' }, embed: { model: 'm', input: ['a'] }, list_models: {},
    }
    for (const f of fences) {
      for (const tool of ollamaToMcp(f)) {
        const plan = ollamaMcpCall(tool.name, args[tool.name], f)
        expect(plan.ok, tool.name).toBe(true)
        if (!plan.ok) continue
        const group = routeGroup(plan.request.path)
        expect(['mutate', 'unknown']).not.toContain(group)
        const route = ollamaBreed.routes.find((r) => r.path === plan.request.path && r.method === plan.request.method)
        expect(route?.class, tool.name).not.toBe('mutate')
      }
    }
  })
})

describe('ollamaMcpResult', () => {
  test('chat returns the assistant text, plus the upstream frame as structuredContent', () => {
    const body = { model: 'llama3.2:1b', message: { role: 'assistant', content: 'Hello' }, done: true, eval_count: 2 }
    expect(ollamaMcpResult('chat', { status: 200, body })).toEqual({ content: [{ type: 'text', text: 'Hello' }], structuredContent: body })
  })

  test('generate returns the response text; embed the embedding array; list_models the names', () => {
    expect(ollamaMcpResult('generate', { status: 200, body: { response: 'hi', done: true } }).content).toEqual([{ type: 'text', text: 'hi' }])
    const embed = ollamaMcpResult('embed', { status: 200, body: { embeddings: [[0.1, 0.2]] } })
    expect(embed).toEqual({ content: [{ type: 'text', text: '[[0.1,0.2]]' }], structuredContent: { embeddings: [[0.1, 0.2]] } })
    const models = ollamaMcpResult('list_models', { status: 200, body: { models: [{ name: 'b' }, { name: 'a' }, { nope: 1 }] } })
    expect(models).toEqual({ content: [{ type: 'text', text: 'a\nb' }], structuredContent: { models: ['a', 'b'] } })
  })

  test('an upstream error or an unreadable body is isError, never a thrown error', () => {
    expect(ollamaMcpResult('chat', { status: 404, body: { error: 'model "x" not found' } }))
      .toEqual({ content: [{ type: 'text', text: 'upstream error (404): model "x" not found' }], isError: true })
    expect(ollamaMcpResult('chat', { status: 200, body: undefined }))
      .toEqual({ content: [{ type: 'text', text: 'the upstream answer could not be read' }], isError: true })
  })
})
```

- [ ] **Step 2: Write the failing ComfyUI tests**

Create `packages/connectors/test/comfyui-mcp-call.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { comfyMcpCall, comfyMcpResult, comfyToMcp, comfyuiBreed, comfyuiConstraint, JOB_RESULT_TOOL } from '../src/index.js'

const template = (id: string) => ({
  id,
  graph: { '6': { class_type: 'CLIPTextEncode', inputs: { text: 'x' } } },
  params: [{ name: 'prompt', type: 'text', target: { node: '6', input: 'text' } }],
  cost: 1,
})
const fence = comfyuiConstraint.parse({ templates: [template('txt2img'), template('a b'), template('a_b')] })

describe('comfyMcpCall (M4 D8)', () => {
  test('run_<tpl> plans the template submit the proxy receives, inverting the name through comfyToolNames', () => {
    expect(comfyMcpCall('run_txt2img', { prompt: 'a cat' }, fence)).toEqual({
      ok: true, request: { method: 'POST', path: '/submit', body: { template_id: 'txt2img', params: { prompt: 'a cat' } } },
    })
    // Sanitising collided: `a b` → run_a_b, `a_b` → run_a_b_2. The map, not un-sanitising, decides.
    expect(comfyMcpCall('run_a_b', {}, fence)).toMatchObject({ ok: true, request: { body: { template_id: 'a b' } } })
    expect(comfyMcpCall('run_a_b_2', {}, fence)).toMatchObject({ ok: true, request: { body: { template_id: 'a_b' } } })
  })

  test('get_job_result plans the scoped result route, with the id path-encoded', () => {
    expect(comfyMcpCall(JOB_RESULT_TOOL, { job_id: 'cf-1' }, fence)).toEqual({ ok: true, request: { method: 'GET', path: '/result/cf-1' } })
    expect(comfyMcpCall(JOB_RESULT_TOOL, { job_id: '../prompt' }, fence)).toEqual({ ok: true, request: { method: 'GET', path: '/result/..%2Fprompt' } })
  })

  test('bad arguments and unlisted tools are refused', () => {
    expect(comfyMcpCall(JOB_RESULT_TOOL, {}, fence)).toEqual({ ok: false, error: 'invalid arguments: job_id must be a non-empty string' })
    expect(comfyMcpCall('run_txt2img', ['x'], fence)).toEqual({ ok: false, error: 'invalid arguments: expected an object' })
    expect(comfyMcpCall('run_ghost', {}, fence)).toEqual({ ok: false, error: 'unknown tool: run_ghost' })
    expect(comfyMcpCall(JOB_RESULT_TOOL, { job_id: 'x' }, comfyuiConstraint.parse({ templates: [] }))).toEqual({ ok: false, error: `unknown tool: ${JOB_RESULT_TOOL}` })
  })

  test('no tool plans one of the breed\'s own upstream routes (all are refused by guard, and /upload/image is mutate)', () => {
    const own = comfyuiBreed.routes.map((r) => r.path)
    for (const tool of comfyToMcp(fence)) {
      const plan = comfyMcpCall(tool.name, tool.name === JOB_RESULT_TOOL ? { job_id: 'j' } : {}, fence)
      expect(plan.ok, tool.name).toBe(true)
      if (!plan.ok) continue
      expect(own.some((p) => plan.request.path === p || plan.request.path.startsWith(`${p}/`)), tool.name).toBe(false)
    }
  })
})

describe('comfyMcpResult', () => {
  test('a run returns its job_id as text and structuredContent', () => {
    expect(comfyMcpResult('run_txt2img', { status: 202, body: { job_id: 'cf-1' } })).toEqual({
      content: [{ type: 'text', text: `Job cf-1 started. Call ${JOB_RESULT_TOOL} with this job_id for the output.` }],
      structuredContent: { job_id: 'cf-1' },
    })
  })

  test('a finished job returns each attached image as image content, and the references as structuredContent', () => {
    const r = comfyMcpResult(JOB_RESULT_TOOL, {
      status: 200,
      body: { done: true, images: [{ filename: 'o.png', subfolder: '', type: 'output', data: 'AAAA', mimeType: 'image/png' }] },
    })
    expect(r).toEqual({
      content: [{ type: 'text', text: 'Job finished with 1 image.' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }],
      structuredContent: { done: true, images: [{ filename: 'o.png', subfolder: '', type: 'output' }] },
    })
  })

  test('a pending job says so; a refusal from handle is isError with its reason', () => {
    expect(comfyMcpResult(JOB_RESULT_TOOL, { status: 200, body: { done: false, images: [] } }).content)
      .toEqual([{ type: 'text', text: 'Job still running. Call again later.' }])
    expect(comfyMcpResult(JOB_RESULT_TOOL, { status: 404, body: { error: 'not found' } }))
      .toEqual({ content: [{ type: 'text', text: 'not found' }], isError: true })
    expect(comfyMcpResult('run_txt2img', { status: 422, body: { error: "undeclared param 'x'" } }))
      .toEqual({ content: [{ type: 'text', text: "undeclared param 'x'" }], isError: true })
  })
})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm exec vitest run packages/connectors/test/ollama-mcp-call.test.ts packages/connectors/test/comfyui-mcp-call.test.ts`
Expected: FAIL — `ollamaMcpCall` / `comfyMcpCall` are not exported.

- [ ] **Step 4: Add the result types and the hooks**

Append to `packages/connectors/src/mcp.ts`:

```ts
/** A `tools/call` result's content blocks (MCP 2026-07-28, server/tools). Only the two M4 returns. */
export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

export interface McpCallToolResult {
  content: McpContent[]
  structuredContent?: Record<string, unknown>
  /** A tool-level failure: the JSON-RPC call itself still succeeds. */
  isError?: boolean
}

export function toolError(text: string): McpCallToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

/** The request a `tools/call` stands for, as the proxy would have received it under `/p/<slug>`. */
export interface McpPlannedRequest {
  method: 'GET' | 'POST'
  path: string
  body?: unknown
}

export type McpCallPlan = { ok: true; request: McpPlannedRequest } | { ok: false; error: string }

/** A plain object, or the refusal every breed gives for anything else. */
export function argsObject(args: unknown): Record<string, unknown> | null {
  return typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : null
}
```

In `packages/connectors/src/breed.ts`, change the import to `import type { McpCallPlan, McpCallToolResult, McpToolDef } from './mcp.js'` and add after `toMcp?`:

```ts
  /**
   * Translate one `tools/call` into the request the proxy would have received (spec M4 D8). Pure, no
   * I/O. It plans; it never enforces — the data plane runs the plan through the same rate limit,
   * quota, `guard()` / `handle` and meter as `ALL /p/:slug/*`. Never plans a `mutate` route.
   */
  mcpCall?(name: string, args: unknown, fence: C): McpCallPlan
  /** Shape the pipeline's answer to a planned request as MCP content. Never throws. */
  mcpResult?(name: string, result: { status: number; body: unknown }): McpCallToolResult
```

- [ ] **Step 5: Implement the Ollama hooks**

Append to `packages/connectors/src/ollama/mcp.ts` (extend the first import with `argsObject, toolError, type McpCallPlan, type McpCallToolResult`):

```ts
const invalid = (why: string): McpCallPlan => ({ ok: false, error: `invalid arguments: ${why}` })

function upstreamError(result: { status: number; body: unknown }): string {
  const e = (result.body as { error?: unknown } | null)?.error
  return `upstream error (${result.status})${typeof e === 'string' && e ? `: ${e}` : ''}`
}

/**
 * Plan an Ollama `tools/call`. Only the fields each tool's inputSchema declares are copied, so a
 * caller cannot reach `options`, `keep_alive` or `format`; inference is always `stream: false`
 * (one JSON-RPC response per call). The model is NOT checked here — `guard()` does that, with the
 * same reason string the proxy returns.
 */
export function ollamaMcpCall(name: string, args: unknown, fence: OllamaConstraint): McpCallPlan {
  if (!ollamaToMcp(fence).some((t) => t.name === name)) return { ok: false, error: `unknown tool: ${name}` }
  const a = argsObject(args)
  if (!a) return invalid('expected an object')
  if (name === 'list_models') return { ok: true, request: { method: 'GET', path: '/api/tags' } }
  if (typeof a.model !== 'string') return invalid('model must be a string')
  switch (name) {
    case 'chat':
      if (!Array.isArray(a.messages) || a.messages.length === 0) return invalid('messages must be a non-empty array')
      return { ok: true, request: { method: 'POST', path: '/api/chat', body: { model: a.model, messages: a.messages, stream: false } } }
    case 'generate':
      if (typeof a.prompt !== 'string') return invalid('prompt must be a string')
      if (a.system !== undefined && typeof a.system !== 'string') return invalid('system must be a string')
      return {
        ok: true,
        request: {
          method: 'POST', path: '/api/generate',
          body: { model: a.model, prompt: a.prompt, ...(a.system === undefined ? {} : { system: a.system }), stream: false },
        },
      }
    case 'embed':
      if (!Array.isArray(a.input) || a.input.length === 0) return invalid('input must be a non-empty array')
      return { ok: true, request: { method: 'POST', path: '/api/embed', body: { model: a.model, input: a.input } } }
  }
  return { ok: false, error: `unknown tool: ${name}` }
}

export function ollamaMcpResult(name: string, result: { status: number; body: unknown }): McpCallToolResult {
  if (result.status >= 400) return toolError(upstreamError(result))
  const body = result.body
  if (typeof body !== 'object' || body === null) return toolError('the upstream answer could not be read')
  const b = body as Record<string, unknown>
  switch (name) {
    case 'chat': {
      const text = (b.message as { content?: unknown } | undefined)?.content
      return typeof text === 'string' ? { content: [{ type: 'text', text }], structuredContent: b } : toolError('the upstream answer had no message')
    }
    case 'generate':
      return typeof b.response === 'string'
        ? { content: [{ type: 'text', text: b.response }], structuredContent: b }
        : toolError('the upstream answer had no response')
    case 'embed':
      return Array.isArray(b.embeddings)
        ? { content: [{ type: 'text', text: JSON.stringify(b.embeddings) }], structuredContent: { embeddings: b.embeddings } }
        : toolError('the upstream answer had no embeddings')
    case 'list_models': {
      const models = Array.isArray(b.models)
        ? [...new Set(b.models.map((m) => (m as { name?: unknown } | null)?.name).filter((n): n is string => typeof n === 'string'))].sort()
        : []
      return { content: [{ type: 'text', text: models.join('\n') }], structuredContent: { models } }
    }
  }
  return toolError(`unknown tool: ${name}`)
}
```

In `packages/connectors/src/ollama/breed.ts`, import `ollamaMcpCall, ollamaMcpResult` beside `ollamaToMcp` and add below `toMcp: ollamaToMcp,`:

```ts
  mcpCall: ollamaMcpCall,
  mcpResult: ollamaMcpResult,
```

In `packages/connectors/src/ollama/index.ts`, change the last line to `export { ollamaMcpCall, ollamaMcpResult, ollamaToMcp } from './mcp.js'`.

- [ ] **Step 6: Implement the ComfyUI hooks**

Append to `packages/connectors/src/comfyui/mcp.ts` (extend the first import with `argsObject, toolError, type McpCallPlan, type McpCallToolResult, type McpContent`):

```ts
/** One image in the scoped result view. `data`/`mimeType` are present only when the data plane attached the bytes. */
export interface JobResultImage {
  filename: string
  subfolder: string
  type: string
  data?: string
  mimeType?: string
}

/**
 * Plan a ComfyUI `tools/call`. `run_<tpl>` becomes the template submit the proxy's `handle` receives
 * (`{ template_id, params }`, inverted through `comfyToolNames`, never by un-sanitising); the
 * arguments go through untouched, because `reconstructGraph` is what refuses an undeclared param.
 * `get_job_result` becomes the scoped result route, which re-checks that the job is this key's.
 */
export function comfyMcpCall(name: string, args: unknown, fence: ComfyConstraint): McpCallPlan {
  const names = comfyToolNames(fence.templates)
  if (name === JOB_RESULT_TOOL) {
    if (names.size === 0) return { ok: false, error: `unknown tool: ${name}` }
    const a = argsObject(args)
    if (!a) return { ok: false, error: 'invalid arguments: expected an object' }
    if (typeof a.job_id !== 'string' || a.job_id.length === 0) return { ok: false, error: 'invalid arguments: job_id must be a non-empty string' }
    return { ok: true, request: { method: 'GET', path: `/result/${encodeURIComponent(a.job_id)}` } }
  }
  const templateId = names.get(name)
  if (templateId === undefined) return { ok: false, error: `unknown tool: ${name}` }
  const a = argsObject(args)
  if (!a) return { ok: false, error: 'invalid arguments: expected an object' }
  return { ok: true, request: { method: 'POST', path: '/submit', body: { template_id: templateId, params: a } } }
}

function reasonOf(body: unknown, status: number): string {
  const e = (body as { error?: unknown } | null)?.error
  return typeof e === 'string' && e ? e : `the request failed (${status})`
}

export function comfyMcpResult(name: string, result: { status: number; body: unknown }): McpCallToolResult {
  if (result.status >= 400) return toolError(reasonOf(result.body, result.status))
  if (name !== JOB_RESULT_TOOL) {
    const jobId = (result.body as { job_id?: unknown } | null)?.job_id
    return typeof jobId === 'string'
      ? { content: [{ type: 'text', text: `Job ${jobId} started. Call ${JOB_RESULT_TOOL} with this job_id for the output.` }], structuredContent: { job_id: jobId } }
      : toolError('the job did not start')
  }
  const b = result.body as { done?: unknown; images?: unknown } | null
  const images = (Array.isArray(b?.images) ? b.images : []) as JobResultImage[]
  const refs = images.map(({ filename, subfolder, type }) => ({ filename, subfolder, type }))
  if (b?.done !== true) {
    return { content: [{ type: 'text', text: 'Job still running. Call again later.' }], structuredContent: { done: false, images: refs } }
  }
  const content: McpContent[] = [{ type: 'text', text: `Job finished with ${images.length} image${images.length === 1 ? '' : 's'}.` }]
  for (const img of images) {
    if (typeof img.data === 'string' && typeof img.mimeType === 'string') content.push({ type: 'image', data: img.data, mimeType: img.mimeType })
  }
  return { content, structuredContent: { done: true, images: refs } }
}
```

In `packages/connectors/src/comfyui/breed.ts`, change `import { comfyToMcp } from './mcp.js'` to `import { comfyMcpCall, comfyMcpResult, comfyToMcp } from './mcp.js'` and add below `toMcp: comfyToMcp,`:

```ts
  mcpCall: comfyMcpCall,
  mcpResult: comfyMcpResult,
```

In `packages/connectors/src/comfyui/index.ts`, change the mcp line to:

```ts
export { comfyMcpCall, comfyMcpResult, comfyToMcp, comfyToolName, comfyToolNames, JOB_RESULT_TOOL } from './mcp.js'
export type { JobResultImage } from './mcp.js'
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/connectors`
Expected: PASS — the new files and every M3 test (`ollama-mcp.test.ts`, `comfyui-mcp.test.ts`, `mcp.test.ts`).

- [ ] **Step 8: Typecheck**

Run: `pnpm -w exec tsc -b`
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add packages/connectors/src packages/connectors/test
git commit -m "feat(connectors): plan and shape MCP tool calls through the breed pipeline"
```

---

### Task 11: OAuth at the data plane

Spec §4.2 and §3.1 *The data plane never needs to know*. The data plane learns to verify an OP access token for one paddock's MCP resource and resolve the oauth key it names. The proxy's key path is narrowed at the same time: `resolveKeyByHash` answers only `kind='live'` keys (an oauth key's hash is of random bytes nobody kept, but the rule is now structural), and `resolveKeyById` answers only `kind='oauth'`. Nothing is routed yet — Task 12 mounts it.

**Files:**
- Modify: `apps/data-plane/src/config/types.ts`, `config-store.ts`, `caching-config-store.ts`
- Create: `apps/data-plane/src/mcp/auth.ts`
- Modify: `apps/data-plane/src/server.ts`
- Modify: `.env.example`
- Create: `apps/data-plane/test/helpers/oauth.ts`
- Modify: `apps/data-plane/test/helpers/seed.ts`, `apps/data-plane/test/server-config.test.ts`, `apps/data-plane/test/caching-config-store.test.ts`, `apps/data-plane/test/security-headers.test.ts`
- Test: `apps/data-plane/test/config-store.test.ts`, `apps/data-plane/test/mcp-auth.test.ts`

**Interfaces:**
- Consumes: `createAccessTokenVerifier`, `TokenError`, `KeySetUnavailableError`, `JWKS_COOLDOWN_MS`, `type AccessTokenVerifier` (Task 2); `signJwtRs256` (Task 2); `mcpResource`, `protectedResourceMetadataUrl`, `requireOrigin`, `MCP_SCOPE` (Task 1).
- Produces:
  - `ResolvedKey.oauthClientId?: string`; `ResolvedPaddock.name: string`.
  - `ConfigStore.resolveKeyById(id: string): Promise<ResolvedKey | null>` (oauth, active only; non-UUID → null).
  - `interface McpAuthDeps { dataPlaneUrl: string; verify: AccessTokenVerifier }`
  - `mcpChallenge(slug: string, dataPlaneUrl: string): string`
  - `authenticateMcp(authorization: string | undefined, slug: string, deps: McpAuthDeps, store: ConfigStore): Promise<{ ok: true; key: ResolvedKey } | { ok: false; res: Response }>`
  - `ServerConfig.dataPlaneUrl`, `ServerConfig.oidcIssuer`, `ServerConfig.oidcInternalUrl`.
  - Test helpers: `startTestIssuer(): Promise<TestIssuer>` (`{ issuer, jwksUrl, verifier, mint(claims), close() }`), `seedOauthKey(db, fx, opts?)`.

- [ ] **Step 1: Write the failing config-store test**

Append to `apps/data-plane/test/config-store.test.ts` (import `seedOauthKey` from `./helpers/seed.js` beside the existing imports):

```ts
describe('the two key paths (M4 §2)', () => {
  test('resolveKeyById answers an active oauth key, with its client id and paddocks', async () => {
    const db = await makeDb()
    const fx = await seedFixture(db)
    const oauth = await seedOauthKey(db, fx, { clientId: 'https://c.example/client.json' })
    const store = new DrizzleConfigStore(db, TEST_RING)
    expect(await store.resolveKeyById(oauth.keyId)).toMatchObject({
      keyId: oauth.keyId, orgId: fx.orgId, status: 'active', paddockSlugs: ['small'], oauthClientId: 'https://c.example/client.json',
    })
  })

  test('resolveKeyById never answers a live key, a revoked key or a non-uuid', async () => {
    const db = await makeDb()
    const fx = await seedFixture(db)
    const oauth = await seedOauthKey(db, fx, { status: 'revoked' })
    const store = new DrizzleConfigStore(db, TEST_RING)
    expect(await store.resolveKeyById(fx.keyId)).toBeNull()
    expect(await store.resolveKeyById(oauth.keyId)).toBeNull()
    expect(await store.resolveKeyById('not-a-uuid')).toBeNull()
  })

  test('resolveKeyByHash never answers an oauth key, even given its hash', async () => {
    const db = await makeDb()
    const fx = await seedFixture(db)
    const oauth = await seedOauthKey(db, fx)
    const store = new DrizzleConfigStore(db, TEST_RING)
    expect(await store.resolveKeyByHash(oauth.hash)).toBeNull()
    expect((await store.resolveKeyByHash(fx.keyHash))?.keyId).toBe(fx.keyId)
  })

  test('a paddock carries its display name', async () => {
    const db = await makeDb()
    await seedFixture(db)
    expect((await new DrizzleConfigStore(db, TEST_RING).getPaddockBySlug('small'))?.name).toBe('Small models')
  })
})
```

- [ ] **Step 2: Add the test helpers**

Append to `apps/data-plane/test/helpers/seed.ts`:

```ts
/**
 * An oauth key as the control plane's `mintOauthKey` writes it (M4 D1): bound to a grant, a client and
 * the user who approved it, scoped to the fixture's paddock (or `paddockId`). Its hash is of random bytes nobody kept.
 */
export async function seedOauthKey(
  db: TestDb,
  fx: Fixture,
  opts: { clientId?: string; grantId?: string; status?: string; paddockId?: string } = {},
): Promise<{ keyId: string; hash: string; clientId: string; userId: string }> {
  const clientId = opts.clientId ?? 'https://mcp-client.example.test/client.json'
  const [u] = await db.insert(schema.user).values({
    orgId: fx.orgId, email: `approver-${randomUUID()}@x.io`, passwordHash: 'unused', role: 'member',
  }).returning()
  const hash = randomBytes(32).toString('hex')
  const [key] = await db.insert(schema.apiKey).values({
    orgId: fx.orgId, name: 'Test MCP client (MCP)', prefix: 'oauth', hash, status: opts.status ?? 'active',
    kind: 'oauth', grantId: opts.grantId ?? randomUUID(), oauthClientId: clientId, userId: u.id,
  }).returning()
  await db.insert(schema.keyPaddock).values({ keyId: key.id, paddockId: opts.paddockId ?? fx.paddockId })
  return { keyId: key.id, hash, clientId, userId: u.id }
}
```

Create `apps/data-plane/test/helpers/oauth.ts`:

```ts
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { createAccessTokenVerifier, type AccessTokenVerifier } from '@metamodels/schema/access-token'
import { signJwtRs256 } from '@metamodels/schema/jws'

export interface TestIssuer {
  issuer: string
  jwksUrl: string
  verifier: AccessTokenVerifier
  /** An RS256 `at+jwt` from this issuer: `iss`, `iat`, `exp` (+15 min) and `jti` filled in unless given. */
  mint(claims: Record<string, unknown>, header?: Record<string, unknown>): string
  close(): Promise<void>
}

/** A stand-in OP: one RSA key, its JWKS on an ephemeral loopback port, and a minting function. */
export async function startTestIssuer(): Promise<TestIssuer> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const kid = randomUUID()
  const jwks = JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] })
  const server = createServer((req, res) => {
    if (req.url !== '/jwks') { res.statusCode = 404; res.end(); return }
    res.setHeader('content-type', 'application/json')
    res.end(jwks)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const jwksUrl = `${issuer}/jwks`
  return {
    issuer,
    jwksUrl,
    verifier: createAccessTokenVerifier({ issuer, jwksUrl, typ: 'at+jwt' }),
    mint(claims, header = {}) {
      const now = Math.floor(Date.now() / 1000)
      return signJwtRs256({ typ: 'at+jwt', kid, ...header }, { iss: issuer, iat: now, exp: now + 900, jti: randomUUID(), ...claims }, privateKey)
    },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}
```

- [ ] **Step 3: Write the failing auth test**

Create `apps/data-plane/test/mcp-auth.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { mcpResource } from '@metamodels/schema'
import { KeySetUnavailableError } from '@metamodels/schema/access-token'
import { DrizzleConfigStore } from '../src/config/config-store.js'
import { authenticateMcp, mcpChallenge } from '../src/mcp/auth.js'
import { startTestIssuer, type TestIssuer } from './helpers/oauth.js'
import { makeDb, seedFixture, seedOauthKey, TEST_RING, type Fixture, type TestDb } from './helpers/seed.js'

const DP = 'http://dp.test'
let op: TestIssuer
let db: TestDb
let fx: Fixture
let oauth: Awaited<ReturnType<typeof seedOauthKey>>
let warn: ReturnType<typeof vi.spyOn>

beforeAll(async () => { op = await startTestIssuer() })
afterAll(async () => { await op.close() })
beforeEach(async () => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  db = await makeDb()
  fx = await seedFixture(db)
  oauth = await seedOauthKey(db, fx)
})
afterEach(() => { warn.mockRestore() })

const deps = () => ({ dataPlaneUrl: DP, verify: op.verifier })
const store = () => new DrizzleConfigStore(db, TEST_RING)
const good = (over: Record<string, unknown> = {}) =>
  op.mint({ aud: mcpResource(DP, 'small'), scope: 'mcp', client_id: oauth.clientId, mm_kid: oauth.keyId, sub: oauth.userId, ...over })
const auth = (header: string | undefined, slug = 'small') => authenticateMcp(header, slug, deps(), store())

async function expectRefused(header: string | undefined, body: string) {
  const out = await auth(header)
  expect(out.ok).toBe(false)
  if (out.ok) return
  expect(out.res.status).toBe(401)
  expect(out.res.headers.get('www-authenticate')).toBe(mcpChallenge('small', DP))
  expect(await out.res.json()).toEqual({ error: body })
}

describe('authenticateMcp (M4 §4.2)', () => {
  test('the challenge names the paddock\'s RFC 9728 metadata document', () => {
    expect(mcpChallenge('small', DP)).toBe('Bearer resource_metadata="http://dp.test/.well-known/oauth-protected-resource/p/small/mcp"')
  })

  test('a token for this paddock, naming its oauth key and client, is accepted', async () => {
    const out = await auth(`Bearer ${good()}`)
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.key).toMatchObject({ keyId: oauth.keyId, oauthClientId: oauth.clientId })
  })

  test('no token: 401, the missing body, the challenge', async () => {
    await expectRefused(undefined, 'missing access token')
    await expectRefused('Basic abc', 'missing access token')
  })

  test('every refused token gets one body and one challenge', async () => {
    const cases: Array<[string, string]> = [
      ['an mm_live_ key', fx.keyPlaintext],
      ['garbage', 'not.a.jwt'],
      ['another paddock\'s token', good({ aud: mcpResource(DP, 'other') })],
      ['an admin-API token', good({ aud: 'http://console.test/api/admin' })],
      ['a token without the mcp scope', good({ scope: 'read' })],
      ['a token naming no key', good({ mm_kid: undefined })],
      ['a token naming a live key', good({ mm_kid: fx.keyId })],
      ['a token from another client', good({ client_id: 'https://evil.example/client.json' })],
      ['an expired token', good({ exp: Math.floor(Date.now() / 1000) - 5 })],
      ['a token with the wrong typ', op.mint({ aud: mcpResource(DP, 'small'), mm_kid: oauth.keyId }, { typ: 'JWT' })],
    ]
    for (const [, token] of cases) await expectRefused(`Bearer ${token}`, 'invalid access token')
  })

  test('a revoked key is refused at once, although its token is still unexpired', async () => {
    const token = good()
    const { apiKey } = await import('@metamodels/schema')
    await db.update(apiKey).set({ status: 'revoked' })
    await expectRefused(`Bearer ${token}`, 'invalid access token')
  })

  test('a key set that cannot be fetched is 503 with Retry-After: 30, not 401', async () => {
    const out = await authenticateMcp(`Bearer ${good()}`, 'small', {
      dataPlaneUrl: DP, verify: async () => { throw new KeySetUnavailableError('the key set endpoint could not be reached') },
    }, store())
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.res.status).toBe(503)
    expect(out.res.headers.get('retry-after')).toBe('30')
  })
})
```

- [ ] **Step 4: Run them to verify they fail**

Run: `pnpm exec vitest run apps/data-plane/test/config-store.test.ts apps/data-plane/test/mcp-auth.test.ts`
Expected: FAIL — `seedOauthKey` fails on the missing `resolveKeyById`; `../src/mcp/auth.js` does not exist.

- [ ] **Step 5: Extend the config types and stores**

In `apps/data-plane/src/config/types.ts`, add to `ResolvedKey`:

```ts
  /** For an oauth key (M4 D1): the CIMD `client_id` it was approved for. Absent for a live key. */
  oauthClientId?: string
```

and to `ResolvedPaddock`, after `slug`:

```ts
  /** The display name: the MCP `serverInfo.title`. */
  name: string
```

In `apps/data-plane/src/config/config-store.ts`: import `and` beside `eq`; add `resolveKeyById` to the interface:

```ts
export interface ConfigStore {
  /** A consumer `mm_live_` key by the hash of its plaintext. `kind='live'` only. */
  resolveKeyByHash(hash: string): Promise<ResolvedKey | null>
  /** An oauth key by id, as an MCP access token's `mm_kid` names it. `kind='oauth'` only (M4 §4.2). */
  resolveKeyById(id: string): Promise<ResolvedKey | null>
  getPaddockBySlug(slug: string): Promise<ResolvedPaddock | null>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
```

and replace `resolveKeyByHash` with the two lookups sharing one resolver:

```ts
  async resolveKeyByHash(hash: string): Promise<ResolvedKey | null> {
    const rows = await this.db.select().from(apiKey).where(and(eq(apiKey.hash, hash), eq(apiKey.kind, 'live'))).limit(1)
    return this.resolve(rows[0])
  }

  async resolveKeyById(id: string): Promise<ResolvedKey | null> {
    // `mm_kid` comes from a verified token, but a malformed id must still be a miss, not a driver error.
    if (!UUID.test(id)) return null
    const rows = await this.db.select().from(apiKey).where(and(eq(apiKey.id, id), eq(apiKey.kind, 'oauth'))).limit(1)
    return this.resolve(rows[0])
  }

  private async resolve(key: typeof apiKey.$inferSelect | undefined): Promise<ResolvedKey | null> {
    if (!key || key.status !== 'active') return null

    const links = await this.db
      .select({ slug: paddock.slug })
      .from(keyPaddock)
      .innerJoin(paddock, eq(keyPaddock.paddockId, paddock.id))
      .where(eq(keyPaddock.keyId, key.id))

    return {
      keyId: key.id,
      orgId: key.orgId,
      status: key.status,
      expiresAt: key.expiresAt ?? null,
      paddockSlugs: links.map((l) => l.slug),
      overrides: (key.overrides as KeyOverrides | null) ?? null,
      ...(key.oauthClientId ? { oauthClientId: key.oauthClientId } : {}),
    }
  }
```

and in `getPaddockBySlug`'s return, add `name: row.paddock.name,` after `slug`.

In `apps/data-plane/src/config/caching-config-store.ts`, add a third map beside `keyCache`:

```ts
  private readonly keyByIdCache = new Map<string, Entry<ResolvedKey | null>>()
```

the method:

```ts
  async resolveKeyById(id: string): Promise<ResolvedKey | null> {
    const cached = this.keyByIdCache.get(id)
    if (this.fresh(cached)) return cached.value
    const value = await this.inner.resolveKeyById(id)
    this.setBounded(this.keyByIdCache, id, { value, expiresAt: this.now() + this.ttlMs })
    return value
  }
```

and `this.keyByIdCache.clear()` in `invalidateAll()` — so a key revoked on the Keys page (which publishes an invalidation, Task 3) is refused on the next MCP request.

Update the two test stubs that implement `ConfigStore`: in `apps/data-plane/test/caching-config-store.test.ts` add to `CountingInner` `async resolveKeyById(): Promise<ResolvedKey | null> { this.keyCalls++; return this.key }` and `name: 'Small'` to `fakePaddock`'s object; in `apps/data-plane/test/security-headers.test.ts` add `resolveKeyById: async () => null,` to `stubConfig`. Then add to `caching-config-store.test.ts`:

```ts
  test('an oauth key by id is cached, and invalidateAll evicts it', async () => {
    const inner = new CountingInner()
    const c = new CachingConfigStore(inner)
    await c.resolveKeyById('k1')
    await c.resolveKeyById('k1')
    expect(inner.keyCalls).toBe(1)
    c.invalidateAll()
    await c.resolveKeyById('k1')
    expect(inner.keyCalls).toBe(2)
  })
```

- [ ] **Step 6: Write the verification**

Create `apps/data-plane/src/mcp/auth.ts`:

```ts
import { MCP_SCOPE, mcpResource, protectedResourceMetadataUrl } from '@metamodels/schema'
import {
  JWKS_COOLDOWN_MS, KeySetUnavailableError, TokenError, type AccessTokenVerifier,
} from '@metamodels/schema/access-token'
import type { ConfigStore } from '../config/config-store.js'
import type { ResolvedKey } from '../config/types.js'

export interface McpAuthDeps {
  /** `DATA_PLANE_URL`: the origin every MCP resource (and so every token's `aud`) is built on. */
  dataPlaneUrl: string
  verify: AccessTokenVerifier
}

/** RFC 9728 §5.1: the bare scheme plus where to discover the authorization server. Nothing else. */
export function mcpChallenge(slug: string, dataPlaneUrl: string): string {
  return `Bearer resource_metadata="${protectedResourceMetadataUrl(mcpResource(dataPlaneUrl, slug))}"`
}

const MISSING = 'missing access token'
/** One body for every refused token, whatever the reason — as `unauthorized.ts` does for keys. */
const INVALID = 'invalid access token'
const COOLDOWN_LOG_EVERY_MS = JWKS_COOLDOWN_MS
let lastCooldownLog = 0

function unauthorized(slug: string, dataPlaneUrl: string, body: string): Response {
  return new Response(JSON.stringify({ error: body }), {
    status: 401,
    headers: { 'content-type': 'application/json', 'www-authenticate': mcpChallenge(slug, dataPlaneUrl) },
  })
}

type Refused = { ok: false; res: Response }

/**
 * Spec M4 §4.2, steps 1–3: the bearer token must be an OP access token for exactly this paddock's MCP
 * resource, naming an active oauth key scoped to this paddock and approved for the token's client.
 * Step 4 (the paddock gates) is the shared pipeline's. `mm_live_` keys never get past step 2: they are
 * not JWTs, and `resolveKeyById` would not answer a live key if one were.
 */
export async function authenticateMcp(
  authorization: string | undefined,
  slug: string,
  deps: McpAuthDeps,
  store: ConfigStore,
): Promise<{ ok: true; key: ResolvedKey } | Refused> {
  const refuse = (reason: string): Refused => {
    // The reason goes to the operator's log only; the caller gets INVALID whatever it is.
    console.warn(`[auth] 401 on /mcp: ${reason}`)
    return { ok: false, res: unauthorized(slug, deps.dataPlaneUrl, INVALID) }
  }

  const token = authorization ? /^Bearer +(.+)$/i.exec(authorization)?.[1]?.trim() : undefined
  if (!token) return { ok: false, res: unauthorized(slug, deps.dataPlaneUrl, MISSING) }
  if (token.startsWith('mm_live_')) return refuse('an API key was presented; MCP takes OAuth access tokens only')

  let claims: Record<string, unknown>
  try {
    claims = await deps.verify(token, mcpResource(deps.dataPlaneUrl, slug))
  } catch (e) {
    if (e instanceof KeySetUnavailableError) {
      const now = Date.now()
      if (!e.cooldownMiss || now - lastCooldownLog >= COOLDOWN_LOG_EVERY_MS) {
        lastCooldownLog = now
        console.error(`[auth] 503 on /mcp: ${e.reason}`)
      }
      return {
        ok: false,
        res: new Response(JSON.stringify({ error: 'access token keys unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json', 'retry-after': String(JWKS_COOLDOWN_MS / 1000) },
        }),
      }
    }
    if (e instanceof TokenError) return refuse(e.reason)
    throw e
  }

  const scopes = typeof claims.scope === 'string' ? claims.scope.split(' ') : []
  if (!scopes.includes(MCP_SCOPE)) return refuse('the token does not carry the mcp scope')
  if (typeof claims.mm_kid !== 'string') return refuse('the token names no key')
  const key = await store.resolveKeyById(claims.mm_kid)
  if (!key) return refuse('the token names no active oauth key')
  if (key.expiresAt && key.expiresAt.getTime() < Date.now()) return refuse('the oauth key has expired')
  if (!key.paddockSlugs.includes(slug)) return refuse('the oauth key is not scoped to this paddock')
  if (claims.client_id !== key.oauthClientId) return refuse('the token client is not the client the key was approved for')
  return { ok: true, key }
}
```

- [ ] **Step 7: Read the new settings at boot**

In `apps/data-plane/src/server.ts`, import `requireOrigin` from `@metamodels/schema` and extend `ServerConfig` and `loadServerConfig`:

```ts
export interface ServerConfig {
  databaseUrl: string
  redisUrl?: string
  port: number
  sealKeys: SealKeyring
  /** `DATA_PLANE_URL`: this service's public origin, the base of every MCP resource (M4 D2). */
  dataPlaneUrl: string
  /** `OIDC_ISSUER`: the `iss` every MCP access token must carry. */
  oidcIssuer: string
  /** Where to fetch the OP's JWKS from inside the deployment. Defaults to the issuer. */
  oidcInternalUrl: string
}

export function loadServerConfig(env: Record<string, string | undefined>): ServerConfig {
  const databaseUrl = env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  const port = env.PORT ? Number(env.PORT) : 8787
  if (Number.isNaN(port)) throw new Error('PORT must be a number')
  const oidcIssuer = requireOrigin('OIDC_ISSUER', env.OIDC_ISSUER)
  // Required at boot even with no credential stored yet: a missing key should stop the deploy, not
  // surface later as one paddock's 503.
  return {
    databaseUrl,
    redisUrl: env.REDIS_URL,
    port,
    sealKeys: loadSealKeyring(env),
    dataPlaneUrl: requireOrigin('DATA_PLANE_URL', env.DATA_PLANE_URL),
    oidcIssuer,
    oidcInternalUrl: env.OIDC_INTERNAL_URL ? requireOrigin('OIDC_INTERNAL_URL', env.OIDC_INTERNAL_URL) : oidcIssuer,
  }
}
```

Replace `apps/data-plane/test/server-config.test.ts`'s environments: add at the top

```ts
const BASE = { DATABASE_URL: 'postgres://x/y', UPSTREAM_AUTH_KEY: KEY, DATA_PLANE_URL: 'http://dp.test', OIDC_ISSUER: 'http://op.test' }
```

rewrite each existing test's env as `{ ...BASE, … }` (the `DATABASE_URL`-missing test becomes `{ ...BASE, DATABASE_URL: undefined }`, the `UPSTREAM_AUTH_KEY` one `{ ...BASE, UPSTREAM_AUTH_KEY: undefined }`), and append:

```ts
  test('reads the MCP origins; the JWKS is fetched from the issuer unless OIDC_INTERNAL_URL says otherwise', () => {
    expect(loadServerConfig(BASE)).toMatchObject({ dataPlaneUrl: 'http://dp.test', oidcIssuer: 'http://op.test', oidcInternalUrl: 'http://op.test' })
    expect(loadServerConfig({ ...BASE, OIDC_INTERNAL_URL: 'http://auth:3100' }).oidcInternalUrl).toBe('http://auth:3100')
  })

  test('refuses to boot without DATA_PLANE_URL or OIDC_ISSUER, or with a path in either', () => {
    expect(() => loadServerConfig({ ...BASE, DATA_PLANE_URL: undefined })).toThrow(/DATA_PLANE_URL is required/)
    expect(() => loadServerConfig({ ...BASE, OIDC_ISSUER: undefined })).toThrow(/OIDC_ISSUER is required/)
    expect(() => loadServerConfig({ ...BASE, DATA_PLANE_URL: 'http://dp.test/p' })).toThrow(/DATA_PLANE_URL must be an origin/)
  })
```

In `.env.example`, `OIDC_INTERNAL_URL` is already documented (the console reads it); change its comment line to:

```bash
# How the console and the data plane reach the auth service server-to-server (the compose network): the
# console for token calls, the data plane for the JWKS that verifies MCP access tokens. Defaults to OIDC_ISSUER.
```

(`DATA_PLANE_URL` was added by Task 4.)

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm exec vitest run apps/data-plane`
Expected: PASS — including the unchanged `app.integration.test.ts`, whose `mm_live_testkey` is `kind='live'` by the column default.

- [ ] **Step 9: Typecheck and the env-docs test**

Run: `pnpm -w exec tsc -b && pnpm exec vitest run packages/schema/test/env-example.test.ts`
Expected: clean; PASS (the data plane reads its settings from the `env` argument, and every key is documented anyway).

- [ ] **Step 10: Commit**

```bash
git add apps/data-plane/src apps/data-plane/test .env.example
git commit -m "feat(data-plane): verify MCP access tokens and resolve the oauth key they name"
```

---

### Task 12: The MCP endpoint (dual-era)

Spec §4.1, §3.8 and §1, and D9 (dual-era). `POST /p/:slug/mcp` becomes a stateless JSON-RPC endpoint that serves two eras of client on one path:

- **Modern (`2026-07-28`).** `server/discover`, `tools/list` and `tools/call`, with the revision's transport rules: `Origin` validation, the `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` headers checked against the body (`-32020` HeaderMismatch), `-32022` for an unsupported version, HTTP 404 + `-32601` for an unknown method. Results carry `resultType`, the cache fields and `_meta["io.modelcontextprotocol/serverInfo"]`.
- **Legacy (`2025-11-25`, `2025-06-18`).** `initialize`, `notifications/initialized`, `ping`, `tools/list` and `tools/call`, served statelessly: no `Mcp-Session-Id` is ever minted, so every legacy request stands alone exactly as a modern one does.

The wire details below were checked against the primary sources on 2026-09-29: the 2026-07-28 schema (`schema/2026-07-28/schema.ts` in `modelcontextprotocol/modelcontextprotocol`), its `basic/transports/streamable-http`, `basic/versioning`, `server/discover` and `server/utilities/caching` pages, and the 2025-11-25 `basic/lifecycle`, `basic/transports`, `basic/utilities/ping` and `server/tools` pages. Two points the schema settles:

- `DiscoverResult` and `ListToolsResult` extend `CacheableResult`, whose `ttlMs: number` is **required** (not optional), and `server/utilities/caching` says servers MUST include caching hints on both. Every modern discover and list result therefore carries `ttlMs: 0` (immediately stale: a fence edit takes effect on the next list) and `cacheScope: 'private'` (the list depends on the caller's paddock).
- `Result.resultType` is required on every modern result, `CallToolResult` included; the 2026-07-28 changelog says servers SHOULD put `serverInfo` in each result's `_meta`. Legacy results carry neither (the 2025-11-25 `ListToolsResult` is `{ tools, nextCursor? }` and `CallToolResult` is `{ content, structuredContent?, isError? }`).

**Era dispatch.** An `initialize` request is legacy. A request with no `params._meta["io.modelcontextprotocol/protocolVersion"]` whose `MCP-Protocol-Version` header names a supported legacy version is legacy. Everything else is validated as modern. So a legacy-shaped request (no `_meta`) with **no** header is treated as modern and refused 400 + `-32020` for the missing header. Two rules lead there. The 2025-11-25 transports page says a server that receives no `MCP-Protocol-Version` header, and has no other way to tell the version, SHOULD assume `2025-03-26`, which this server does not serve; that page also requires 400 for an unsupported version. The 2026-07-28 streamable-http page says a server that does not support pre-`2025-06-18` clients MUST reject a request without the header per Server Validation. `initialize` itself is exempt: 2025-11-25 requires the header only on requests *after* initialization. Notifications from either era get 202 with no body and no header checks: 2026-07-28 defines no header requirements for notification POSTs.

**Order on every POST:** unknown slug or MCP not configured → 404; a foreign `Origin` → 403; the token (401 or 503, Task 11); body → `-32700` / `-32600` (400); a notification → 202; era validation → 400 (`-32020` / `-32022`); paddock gates (404 / 503); then dispatch. `Mcp-Session-Id` and `Last-Event-ID` are never read, and no response carries a session id. GET and DELETE get 405.

The proxy's gate pipeline is factored out of `app.ts` into `pipeline.ts` first, unchanged in behaviour. The proxy and both MCP eras then run the same rate limit → quota → `guard()` / `handle` / proxy → meter code. The MCP routes are always registered before the `ALL /p/:slug/*` catch-all, so even a data plane without MCP configured answers 404 there, and the proxy never sees `/mcp`.

Every `tools/call` is rate-limited and quota-checked, including `get_job_result`, as spec §1 says. The REST result route has no rate limit (`app.ts:185-231`) and stays as it is. `get_job_result`'s images are fetched from ComfyUI's `/view` by the data plane (an internal step, like `handle`'s `/upload/image`), capped at `MCP_MAX_IMAGE_BYTES` per result.

`serverInfo.version` is the literal `'0.0.0'`: the stack exposes no version of its own (every `package.json` says `0.0.0`, nothing reads one, and the images carry no version label), and no build plumbing is added.

**Files:**
- Create: `apps/data-plane/src/pipeline.ts`
- Modify: `apps/data-plane/src/app.ts` (replaced whole)
- Create: `apps/data-plane/src/mcp/jsonrpc.ts`, `apps/data-plane/src/mcp/protocol.ts`, `apps/data-plane/src/mcp/endpoint.ts`, `apps/data-plane/src/mcp/job-images.ts`
- Modify: `apps/data-plane/src/server.ts`
- Modify: `apps/data-plane/test/helpers/fake-ollama.ts`, `apps/data-plane/test/helpers/fake-comfyui.ts`
- Test: `apps/data-plane/test/mcp-protocol.test.ts`, `apps/data-plane/test/mcp.integration.test.ts`

**Interfaces:**
- Consumes: `authenticateMcp`, `McpAuthDeps` (Task 11); `mcpCall` / `mcpResult`, `toolError`, `McpCallToolResult`, `JobResultImage` (Task 10); `createAccessTokenVerifier` (Task 2); `PADDOCK_SLUG_RE`, `PADDOCK_SLUG_MAX` (Task 1); `startTestIssuer`, `seedOauthKey` (Task 11).
- Produces:
  - `pipeline.ts`: `Scope`, `Refusal { status: number; body: Record<string, unknown>; headers?: Record<string, string> }`, `BreedOutcome`, `PipelineDeps`, `Pipeline { paddockScope, limits, run, jobResult, raw, drain }`, `createPipeline(deps)`, `refusalReason(r)`.
  - `mcp/jsonrpc.ts`: `MODERN_PROTOCOL_VERSIONS = ['2026-07-28']`, `LEGACY_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18']`, `SUPPORTED_PROTOCOL_VERSIONS`, `PROTOCOL_VERSION_META`, `SERVER_INFO_META`, `MCP_SERVER_NAME = 'metamodels'`, `MCP_SERVER_VERSION = '0.0.0'`, `MCP_CACHE_TTL_MS = 0`, `JSONRPC_ERRORS` (incl. `headerMismatch: -32020`, `unsupportedProtocolVersion: -32022`), `JsonRpcId`, `JsonRpcMessage`, `parseJsonRpc`, `rpcResult`, `rpcError(id, code, message, data?)`.
  - `mcp/protocol.ts`: `type Era = 'modern' | 'legacy'`, `decodeHeaderValue(value): string | null`, `metaVersion(params): unknown`, `eraOf(method, params, headerVersion): Era`, `interface HttpRpcError { status: 400; body }`, `validateModern(id, method, params, header): HttpRpcError | null`, `validateLegacy(id, method, header): HttpRpcError | null`, `legacyNegotiatedVersion(requested: unknown): string`.
  - `mcp/job-images.ts`: `MCP_MAX_IMAGE_BYTES = 8 MiB`, `attachImageBytes(body, view, cap)`.
  - `mcp/endpoint.ts`: `interface McpDeps extends McpAuthDeps { oidcIssuer: string; maxImageBytes?: number }`, `registerMcpRoutes(app, { pipeline, configStore, mcp? })`.
  - `AppDeps.mcp?: McpDeps`.
  - Test helpers: `FAKE_PNG` (8 bytes, served by the fake ComfyUI's `/view`).

- [ ] **Step 1: Write the failing protocol unit test**

Create `apps/data-plane/test/mcp-protocol.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { JSONRPC_ERRORS, parseJsonRpc, rpcError, rpcResult, SUPPORTED_PROTOCOL_VERSIONS } from '../src/mcp/jsonrpc.js'
import { decodeHeaderValue, eraOf, legacyNegotiatedVersion, validateLegacy, validateModern } from '../src/mcp/protocol.js'

const META = { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } }
const headersOf = (h: Record<string, string>) => (name: string) => h[name.toLowerCase()]

describe('parseJsonRpc', () => {
  test('a request, with or without params', () => {
    expect(parseJsonRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).toEqual({ kind: 'request', id: 1, method: 'tools/list', params: undefined })
    expect(parseJsonRpc({ jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { name: 'x' } }))
      .toEqual({ kind: 'request', id: 'a', method: 'tools/call', params: { name: 'x' } })
  })

  test('a notification has no id', () => {
    expect(parseJsonRpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).toEqual({ kind: 'notification', method: 'notifications/initialized' })
  })

  test('batches, wrong versions, bad ids, bad methods and bad params are invalid', () => {
    expect(parseJsonRpc([{ jsonrpc: '2.0', id: 1, method: 'x' }])).toEqual({ kind: 'invalid', id: null, message: 'batch requests are not supported' })
    expect(parseJsonRpc({ jsonrpc: '1.0', id: 1, method: 'x' })).toEqual({ kind: 'invalid', id: 1, message: 'jsonrpc must be "2.0"' })
    expect(parseJsonRpc({ jsonrpc: '2.0', id: null, method: 'x' })).toEqual({ kind: 'invalid', id: null, message: 'id must be a string or a number' })
    expect(parseJsonRpc({ jsonrpc: '2.0', id: 1, method: 7 })).toEqual({ kind: 'invalid', id: 1, message: 'method must be a string' })
    expect(parseJsonRpc({ jsonrpc: '2.0', id: 1, method: 'x', params: 'p' })).toEqual({ kind: 'invalid', id: 1, message: 'params must be an object or an array' })
    expect(parseJsonRpc('nope')).toEqual({ kind: 'invalid', id: null, message: 'expected a JSON-RPC 2.0 object' })
  })

  test('responses; an error carries data only when given', () => {
    expect(rpcResult(1, { ok: true })).toEqual({ jsonrpc: '2.0', id: 1, result: { ok: true } })
    expect(rpcError(null, JSONRPC_ERRORS.parseError, 'parse error')).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
    expect(rpcError(1, -32022, 'x', { a: 1 })).toEqual({ jsonrpc: '2.0', id: 1, error: { code: -32022, message: 'x', data: { a: 1 } } })
  })
})

describe('decodeHeaderValue (streamable-http §Value Encoding)', () => {
  test('plain ASCII is itself; the Base64 sentinel is decoded as UTF-8', () => {
    expect(decodeHeaderValue('get_weather')).toBe('get_weather')
    expect(decodeHeaderValue('=?base64?SGVsbG8sIOS4lueVjA==?=')).toBe('Hello, 世界')
    expect(decodeHeaderValue('=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=')).toBe('=?base64?literal?=')
  })

  test('a value with invalid characters, or a sentinel that is not Base64, is null', () => {
    expect(decodeHeaderValue('bad\nvalue')).toBeNull()
    expect(decodeHeaderValue('=?base64?not base64!?=')).toBeNull()
  })
})

describe('eraOf (versioning §Backward Compatibility)', () => {
  test('initialize is legacy; a legacy header with no _meta version is legacy; everything else is modern', () => {
    expect(eraOf('initialize', { protocolVersion: '2025-11-25' }, undefined)).toBe('legacy')
    expect(eraOf('tools/list', undefined, '2025-11-25')).toBe('legacy')
    expect(eraOf('tools/list', {}, '2025-06-18')).toBe('legacy')
    expect(eraOf('tools/list', META, '2026-07-28')).toBe('modern')
    expect(eraOf('tools/list', META, '2025-11-25')).toBe('modern')
    expect(eraOf('tools/list', undefined, undefined)).toBe('modern')
    expect(eraOf('tools/list', undefined, '2025-03-26')).toBe('modern')
  })

  test('legacy initialize echoes a supported legacy version, else answers the newest legacy one', () => {
    expect(legacyNegotiatedVersion('2025-06-18')).toBe('2025-06-18')
    expect(legacyNegotiatedVersion('2025-11-25')).toBe('2025-11-25')
    expect(legacyNegotiatedVersion('2024-11-05')).toBe('2025-11-25')
    expect(legacyNegotiatedVersion(undefined)).toBe('2025-11-25')
  })

  test('initialize takes no header, but refuses one naming a version this server does not speak', () => {
    expect(validateLegacy(1, 'initialize', headersOf({}))).toBeNull()
    expect(validateLegacy(1, 'initialize', headersOf({ 'mcp-protocol-version': '2025-11-25' }))).toBeNull()
    expect(validateLegacy(1, 'initialize', headersOf({ 'mcp-protocol-version': '1900-01-01' }))?.status).toBe(400)
    expect(validateLegacy(1, 'tools/list', headersOf({ 'mcp-protocol-version': '2025-11-25' }))).toBeNull()
  })
})

describe('validateModern (streamable-http §Server Validation)', () => {
  const ok = { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'chat' }
  const params = { name: 'chat', arguments: {}, ...META }
  const code = (r: ReturnType<typeof validateModern>) => r?.body.error.code

  test('matching headers pass; the Base64 sentinel is decoded before comparing', () => {
    expect(validateModern(1, 'tools/call', params, headersOf(ok))).toBeNull()
    expect(validateModern(1, 'tools/call', params, headersOf({ ...ok, 'mcp-name': `=?base64?${Buffer.from('chat').toString('base64')}?=` }))).toBeNull()
    expect(validateModern(1, 'tools/list', META, headersOf({ 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' }))).toBeNull()
  })

  test('a missing or mismatched header, or a header that disagrees with _meta, is 400 + -32020', () => {
    const cases: Array<Record<string, string>> = [
      { 'mcp-method': 'tools/call', 'mcp-name': 'chat' },
      { ...ok, 'mcp-protocol-version': '2026-07-29' },
      { 'mcp-protocol-version': '2026-07-28', 'mcp-name': 'chat' },
      { ...ok, 'mcp-method': 'tools/list' },
      { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call' },
      { ...ok, 'mcp-name': 'embed' },
      { ...ok, 'mcp-name': 'ch\u0001at' },
    ]
    for (const h of cases) {
      const r = validateModern(1, 'tools/call', params, headersOf(h))
      expect(r?.status, JSON.stringify(h)).toBe(400)
      expect(code(r), JSON.stringify(h)).toBe(-32020)
    }
    expect(code(validateModern(1, 'tools/list', {}, headersOf({ 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' })))).toBe(-32020)
  })

  test('an unsupported version that header and _meta agree on is 400 + -32022 with supported and requested', () => {
    const r = validateModern(1, 'tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } },
      headersOf({ 'mcp-protocol-version': '1900-01-01', 'mcp-method': 'tools/list' }))
    expect(r).toEqual({
      status: 400,
      body: { jsonrpc: '2.0', id: 1, error: { code: -32022, message: 'Unsupported protocol version', data: { supported: [...SUPPORTED_PROTOCOL_VERSIONS], requested: '1900-01-01' } } },
    })
  })
})
```

- [ ] **Step 2: Extend the fakes**

In `apps/data-plane/test/helpers/fake-ollama.ts`, make the two non-streaming answers carry their text, as real Ollama does. Chat gains the assistant message:

```ts
    if (body.stream === false) return c.json({ ...finalFrame, message: { role: 'assistant', content: 'Hello' } })
```

and generate's `response` must not be overwritten by the final frame's empty one (today `{ response: 'hi', ...finalFrame }` answers `response: ''`):

```ts
    if (body.stream === false) return c.json({ ...finalFrame, response: 'hi' })
```

In `apps/data-plane/test/helpers/fake-comfyui.ts`, add below the imports:

```ts
/** What `GET /view` serves for every image: eight bytes that are the PNG signature. */
export const FAKE_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
```

add `- \`GET  /view\`          → \`FAKE_PNG\` as image/png, for any filename` to the doc comment, and register before `return`:

```ts
  app.get('/view', () => new Response(FAKE_PNG, { headers: { 'content-type': 'image/png', 'content-length': String(FAKE_PNG.length) } }))
```

- [ ] **Step 3: Write the failing endpoint test**

Create `apps/data-plane/test/mcp.integration.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '@metamodels/schema'
import { mcpResource } from '@metamodels/schema'
import { ollamaConstraint, ollamaToMcp } from '@metamodels/connectors'
import { createApp, type AppDeps } from '../src/app.js'
import { buildRegistry } from '../src/breeds.js'
import { DrizzleConfigStore } from '../src/config/config-store.js'
import { InMemoryJobStore } from '../src/jobs/job-store.js'
import { InMemoryMeterSink } from '../src/meter/meter-sink.js'
import { InMemoryRateLimiter } from '../src/ratelimit/rate-limiter.js'
import { mcpChallenge } from '../src/mcp/auth.js'
import { MCP_SERVER_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '../src/mcp/jsonrpc.js'
import { createFakeComfyui, FAKE_PNG, type FakeComfyui } from './helpers/fake-comfyui.js'
import { createFakeOllama } from './helpers/fake-ollama.js'
import { startTestIssuer, type TestIssuer } from './helpers/oauth.js'
import { makeDb, seedFixture, seedOauthKey, TEST_RING, type Fixture, type TestDb } from './helpers/seed.js'

const DP = 'http://dp.test'
const VERSION = '2026-07-28'
const LEGACY = '2025-11-25'
const META = { 'io.modelcontextprotocol/protocolVersion': VERSION, 'io.modelcontextprotocol/clientCapabilities': {} }
const SERVER_INFO = { 'io.modelcontextprotocol/serverInfo': { name: 'metamodels', version: MCP_SERVER_VERSION } }
let op: TestIssuer
let db: TestDb
let fx: Fixture
let oauth: Awaited<ReturnType<typeof seedOauthKey>>
let sink: InMemoryMeterSink
let comfy: FakeComfyui
let upstreamCalls: string[]
let app: ReturnType<typeof createApp>['app']
let drainMeters: () => Promise<void>
let warn: ReturnType<typeof vi.spyOn>

beforeAll(async () => { op = await startTestIssuer() })
afterAll(async () => { await op.close() })
afterEach(() => { warn.mockRestore() })

function build(over: Partial<AppDeps> = {}) {
  const ollama = createFakeOllama()
  const built = createApp({
    configStore: new DrizzleConfigStore(db, TEST_RING),
    rateLimiter: new InMemoryRateLimiter(),
    meterSink: sink,
    registry: buildRegistry(),
    jobStore: new InMemoryJobStore(),
    fetchImpl: (url, init) => {
      upstreamCalls.push(url)
      return url.startsWith('http://fake.comfyui') ? comfy.request(url, init) : ollama.request(url, init)
    },
    mcp: { dataPlaneUrl: DP, oidcIssuer: op.issuer, verify: op.verifier },
    ...over,
  })
  app = built.app
  drainMeters = built.drainMeters
}

beforeEach(async () => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  db = await makeDb()
  fx = await seedFixture(db)
  oauth = await seedOauthKey(db, fx)
  sink = new InMemoryMeterSink()
  comfy = createFakeComfyui()
  upstreamCalls = []
  build()
})

const tokenFor = (key: { keyId: string; clientId: string }, slug = 'small') =>
  op.mint({ aud: mcpResource(DP, slug), scope: 'mcp', client_id: key.clientId, mm_kid: key.keyId })

/**
 * One POST to the endpoint. Unless overridden, it carries the modern request headers derived from
 * the body — `MCP-Protocol-Version` from `_meta`, `Mcp-Method`, and `Mcp-Name` for `tools/call` — as a
 * conforming 2026-07-28 client sends them. An override of `null` removes a header.
 */
function post(slug: string, body: unknown, o: { token?: string | null; headers?: Record<string, string | null> } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  const token = o.token === undefined ? tokenFor(oauth, slug) : o.token
  if (token) headers.authorization = `Bearer ${token}`
  const b = body as { method?: unknown; params?: { name?: unknown; _meta?: Record<string, unknown> } } | null
  const version = b?.params?._meta?.['io.modelcontextprotocol/protocolVersion']
  if (typeof version === 'string') headers['mcp-protocol-version'] = version
  if (typeof b?.method === 'string' && typeof version === 'string') headers['mcp-method'] = b.method
  if (b?.method === 'tools/call' && typeof b.params?.name === 'string') headers['mcp-name'] = b.params.name
  for (const [k, v] of Object.entries(o.headers ?? {})) {
    if (v === null) delete headers[k]
    else headers[k] = v
  }
  return app.request(`${DP}/p/${slug}/mcp`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })
}

let nextId = 1
type Rpc = { status: number; headers: Headers; body: { result?: any; error?: { code: number; message: string; data?: any } } }
async function send(res: Response): Promise<Rpc> {
  const text = await res.text()
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : {} }
}
/** A modern request: `_meta` in the body, the derived headers on the POST. */
async function rpc(method: string, params: Record<string, unknown> = {}, slug = 'small', o: { token?: string | null; headers?: Record<string, string | null> } = {}) {
  return send(await post(slug, { jsonrpc: '2.0', id: nextId++, method, params: { ...params, _meta: META } }, o))
}
/** A legacy request: no `_meta`; the negotiated version in `MCP-Protocol-Version` (none on `initialize`). */
async function legacy(method: string, params?: Record<string, unknown>, slug = 'small', o: { token?: string | null; version?: string | null } = {}) {
  const version = o.version === undefined ? (method === 'initialize' ? null : LEGACY) : o.version
  return send(await post(slug, { jsonrpc: '2.0', id: nextId++, method, ...(params === undefined ? {} : { params }) }, {
    token: o.token, headers: version === null ? {} : { 'mcp-protocol-version': version },
  }))
}
const call = (name: string, args: unknown, slug = 'small', o: { token?: string | null } = {}) => rpc('tools/call', { name, arguments: args }, slug, o)
const messages = [{ role: 'user', content: 'hi' }]
const fence = ollamaConstraint.parse({ allowedRoutes: ['chat', 'generate', 'embed', 'read'], allowedModels: ['llama3.2:1b'] })

describe('modern (2026-07-28): results', () => {
  test('server/discover is exactly the DiscoverResult the schema asks for', async () => {
    const { status, body } = await rpc('server/discover')
    expect(status).toBe(200)
    expect(body.result).toEqual({
      resultType: 'complete',
      supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      capabilities: { tools: {} },
      _meta: SERVER_INFO,
      ttlMs: 0,
      cacheScope: 'private',
    })
  })

  test('tools/list is the fence\'s toMcp as a cacheable, private ListToolsResult; a cursor is ignored', async () => {
    const { body } = await rpc('tools/list', { cursor: 'x' })
    expect(body.result).toEqual({ resultType: 'complete', tools: ollamaToMcp(fence), ttlMs: 0, cacheScope: 'private', _meta: SERVER_INFO })
  })

  test('tools/call is a CallToolResult with resultType and serverInfo', async () => {
    const { body } = await call('list_models', {})
    expect(body.result).toEqual({
      resultType: 'complete', content: [{ type: 'text', text: 'llama3.2:1b' }], structuredContent: { models: ['llama3.2:1b'] }, _meta: SERVER_INFO,
    })
  })
})

describe('modern (2026-07-28): transport rules', () => {
  test('an unknown method is HTTP 404 + -32601; ping and resources/list are not modern methods here', async () => {
    for (const method of ['resources/list', 'ping']) {
      const r = await rpc(method)
      expect(r.status, method).toBe(404)
      expect(r.body.error?.code, method).toBe(-32601)
    }
  })

  test('a batch is 400 + -32600; an unparseable body 400 + -32700; a notification 202 with no body', async () => {
    const batch = await send(await post('small', [{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META } }]))
    expect([batch.status, batch.body.error?.code]).toEqual([400, -32600])
    const bad = await send(await post('small', '{not json'))
    expect([bad.status, bad.body.error?.code]).toEqual([400, -32700])
    const note = await post('small', { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } })
    expect(note.status).toBe(202)
    expect(await note.text()).toBe('')
  })

  test('Origin: absent or our own is served; any other is 403 and never reaches the token check', async () => {
    expect((await rpc('tools/list')).status).toBe(200)
    expect((await rpc('tools/list', {}, 'small', { headers: { origin: DP } })).status).toBe(200)
    const foreign = await rpc('tools/list', {}, 'small', { token: null, headers: { origin: 'https://evil.example' } })
    expect(foreign.status).toBe(403)
    expect(foreign.body.error?.code).toBe(-32600)
    expect(foreign.body).not.toHaveProperty('id')
  })

  test('missing or mismatched MCP-Protocol-Version, Mcp-Method or Mcp-Name is 400 + -32020', async () => {
    const cases: Array<[string, Record<string, string | null>]> = [
      ['no MCP-Protocol-Version', { 'mcp-protocol-version': null }],
      ['MCP-Protocol-Version differs from _meta', { 'mcp-protocol-version': '2025-11-25' }],
      ['no Mcp-Method', { 'mcp-method': null }],
      ['Mcp-Method differs from the body', { 'mcp-method': 'tools/list' }],
      ['no Mcp-Name on tools/call', { 'mcp-name': null }],
      ['Mcp-Name differs from params.name', { 'mcp-name': 'chat' }],
    ]
    for (const [what, headers] of cases) {
      const r = await rpc('tools/call', { name: 'list_models', arguments: {} }, 'small', { headers })
      expect([r.status, r.body.error?.code], what).toEqual([400, -32020])
    }
    expect(upstreamCalls).toEqual([])
  })

  test('an Mcp-Name in the Base64 sentinel is decoded before it is compared', async () => {
    const sentinel = `=?base64?${Buffer.from('list_models').toString('base64')}?=`
    const r = await rpc('tools/call', { name: 'list_models', arguments: {} }, 'small', { headers: { 'mcp-name': sentinel } })
    expect(r.status).toBe(200)
    expect(r.body.result.isError).toBeUndefined()
  })

  test('an unsupported version is 400 + -32022 naming the supported versions and the requested one', async () => {
    const r = await send(await post('small', {
      jsonrpc: '2.0', id: 7, method: 'tools/list', params: { _meta: { ...META, 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } },
    }))
    expect(r.status).toBe(400)
    expect(r.body.error).toEqual({ code: -32022, message: 'Unsupported protocol version', data: { supported: [...SUPPORTED_PROTOCOL_VERSIONS], requested: '1900-01-01' } })
  })

  test('Mcp-Session-Id and Last-Event-ID are ignored, and no session id is ever minted', async () => {
    const r = await rpc('tools/list', {}, 'small', { headers: { 'mcp-session-id': 'abc', 'last-event-id': '42' } })
    expect(r.status).toBe(200)
    expect(r.headers.get('mcp-session-id')).toBeNull()
  })

  test('GET and DELETE are 405, allowing POST', async () => {
    for (const method of ['GET', 'DELETE']) {
      const res = await app.request(`${DP}/p/small/mcp`, { method, headers: { authorization: `Bearer ${tokenFor(oauth)}` } })
      expect(res.status).toBe(405)
      expect(res.headers.get('allow')).toBe('POST')
    }
  })

  test('the proxy catch-all never sees /mcp, even with MCP not configured', async () => {
    build({ mcp: undefined })
    const res = await app.request(`${DP}/p/small/mcp`, {
      method: 'POST', headers: { authorization: `Bearer ${fx.keyPlaintext}`, 'content-type': 'application/json' }, body: '{}',
    })
    expect(res.status).toBe(404)
    expect(upstreamCalls).toEqual([])
  })
})

describe('legacy (2025-11-25, 2025-06-18), stateless (D9)', () => {
  test('initialize echoes a supported legacy version, and mints no session', async () => {
    const r = await legacy('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } })
    expect(r.status).toBe(200)
    expect(r.body.result).toEqual({
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'metamodels', title: 'Small models', version: MCP_SERVER_VERSION },
    })
    expect(r.headers.get('mcp-session-id')).toBeNull()
  })

  test('initialize with a version this server does not speak answers the newest legacy version', async () => {
    const r = await legacy('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'c', version: '1' } })
    expect(r.body.result.protocolVersion).toBe('2025-11-25')
  })

  test('notifications/initialized is 202 with no body; ping is {}', async () => {
    const note = await post('small', { jsonrpc: '2.0', method: 'notifications/initialized' }, { headers: { 'mcp-protocol-version': LEGACY } })
    expect(note.status).toBe(202)
    expect(await note.text()).toBe('')
    expect((await legacy('ping')).body.result).toEqual({})
  })

  test('tools/list and tools/call reuse the handlers, in legacy result shapes', async () => {
    expect((await legacy('tools/list')).body.result).toEqual({ tools: ollamaToMcp(fence) })
    const chat = await legacy('tools/call', { name: 'chat', arguments: { model: 'llama3.2:1b', messages } }, 'small', { version: '2025-06-18' })
    expect(chat.body.result).toMatchObject({ content: [{ type: 'text', text: 'Hello' }] })
    expect(chat.body.result).not.toHaveProperty('resultType')
    expect(chat.body.result).not.toHaveProperty('_meta')
    await drainMeters()
    expect(Object.fromEntries(sink.events.map((e) => [e.dim, e.value]))).toEqual({ tokens_in: 11, tokens_out: 22 })
    expect(sink.events[0]).toMatchObject({ keyId: oauth.keyId, paddockId: fx.paddockId })
  })

  test('an unknown legacy method is -32601; an unknown tool is -32602', async () => {
    expect((await legacy('server/discover')).body.error?.code).toBe(-32601)
    expect((await legacy('tools/call', { name: 'pull', arguments: {} })).body.error?.code).toBe(-32602)
  })

  test('a legacy request without MCP-Protocol-Version is refused 400 + -32020 (it cannot be told from a malformed modern one)', async () => {
    const r = await legacy('tools/list', undefined, 'small', { version: null })
    expect([r.status, r.body.error?.code]).toEqual([400, -32020])
  })

  test('the same OAuth rules: no token 401 with resource_metadata; an mm_live_ key 401; a foreign Origin 403', async () => {
    const none = await legacy('initialize', { protocolVersion: LEGACY }, 'small', { token: null })
    expect(none.status).toBe(401)
    expect(none.headers.get('www-authenticate')).toBe(mcpChallenge('small', DP))
    expect((await legacy('tools/list', undefined, 'small', { token: fx.keyPlaintext })).status).toBe(401)
    const foreign = await post('small', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LEGACY } }, { headers: { origin: 'https://evil.example' } })
    expect(foreign.status).toBe(403)
  })

  test('the rate limit is one budget across both eras (fence max 5/60s)', async () => {
    for (let i = 0; i < 3; i++) expect((await call('list_models', {})).body.result.isError).toBeUndefined()
    for (let i = 0; i < 2; i++) expect((await legacy('tools/call', { name: 'list_models', arguments: {} })).body.result.isError).toBeUndefined()
    expect((await legacy('tools/call', { name: 'list_models', arguments: {} })).body.result)
      .toEqual({ content: [{ type: 'text', text: 'rate limit exceeded' }], isError: true })
  })
})

describe('POST /p/:slug/mcp — authentication (M4 §4.2, §7)', () => {
  test('no token: 401 with resource_metadata', async () => {
    const res = await post('small', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META } }, { token: null })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe(mcpChallenge('small', DP))
  })

  test('an mm_live_ key, another paddock\'s token and an admin-API token are 401', async () => {
    for (const token of [fx.keyPlaintext, tokenFor(oauth, 'other'), op.mint({ aud: 'http://console.test/api/admin', scope: 'read', client_id: 'x' })]) {
      expect((await rpc('tools/list', {}, 'small', { token })).status).toBe(401)
    }
  })

  test('an oauth token on the proxy is 401', async () => {
    const res = await app.request(`${DP}/p/small/api/chat`, {
      method: 'POST', headers: { authorization: `Bearer ${tokenFor(oauth)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'llama3.2:1b', messages }),
    })
    expect(res.status).toBe(401)
    expect(upstreamCalls).toEqual([])
  })

  test('a revoked key is 401 on its next request; a disabled paddock is 404', async () => {
    await db.update(schema.apiKey).set({ status: 'revoked' }).where(eq(schema.apiKey.id, oauth.keyId))
    expect((await rpc('tools/list')).status).toBe(401)
    await db.update(schema.apiKey).set({ status: 'active' }).where(eq(schema.apiKey.id, oauth.keyId))
    await db.update(schema.paddock).set({ status: 'disabled' }).where(eq(schema.paddock.id, fx.paddockId))
    expect((await rpc('tools/list')).status).toBe(404)
  })
})

describe('tools/call on an Ollama paddock (M4 §3.8)', () => {
  test('chat runs through the proxy pipeline and is metered under the oauth key', async () => {
    const { body } = await call('chat', { model: 'llama3.2:1b', messages })
    expect(body.result).toMatchObject({ resultType: 'complete', content: [{ type: 'text', text: 'Hello' }] })
    expect(body.result.isError).toBeUndefined()
    await drainMeters()
    expect(Object.fromEntries(sink.events.map((e) => [e.dim, e.value]))).toEqual({ tokens_in: 11, tokens_out: 22 })
    expect(sink.events[0]).toMatchObject({ keyId: oauth.keyId, paddockId: fx.paddockId, breedId: 'ollama' })
  })

  test('a disallowed model is isError with the fence\'s reason, and never reaches upstream', async () => {
    const { status, body } = await call('chat', { model: 'llama3:70b', messages })
    expect(status).toBe(200)
    expect(body.result).toEqual({ resultType: 'complete', content: [{ type: 'text', text: 'model not allowed: llama3:70b' }], isError: true, _meta: SERVER_INFO })
    expect(upstreamCalls).toEqual([])
  })

  test('list_models, embed and generate', async () => {
    expect((await call('list_models', {})).body.result.structuredContent).toEqual({ models: ['llama3.2:1b'] })
    expect((await call('embed', { model: 'llama3.2:1b', input: ['a'] })).body.result.structuredContent).toEqual({ embeddings: [[0.1, 0.2]] })
    expect((await call('generate', { model: 'llama3.2:1b', prompt: 'p' })).body.result.content).toEqual([{ type: 'text', text: 'hi' }])
  })

  test('an unknown tool, or a mutate route by name, is -32602', async () => {
    const pull = await call('pull', { name: 'x' })
    expect([pull.status, pull.body.error?.code]).toEqual([200, -32602])
  })

  test('tools/call is rate-limited like the proxy (fence max 5/60s); tools/list is not', async () => {
    for (let i = 0; i < 10; i++) expect((await rpc('tools/list')).status).toBe(200)
    for (let i = 0; i < 5; i++) expect((await call('list_models', {})).body.result.isError).toBeUndefined()
    expect((await call('list_models', {})).body.result).toMatchObject({ content: [{ type: 'text', text: 'rate limit exceeded' }], isError: true })
  })

  test('an unreachable upstream is isError, and the JSON-RPC call still succeeds', async () => {
    build({ fetchImpl: async () => { throw new TypeError('fetch failed') } })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { status, body } = await call('list_models', {})
    err.mockRestore()
    expect(status).toBe(200)
    expect(body.result).toMatchObject({ content: [{ type: 'text', text: 'the upstream could not be reached' }], isError: true })
  })
})

describe('tools/call on a ComfyUI paddock (M4 §3.8)', () => {
  const txt2img = {
    id: 'txt2img',
    graph: {
      '6': { class_type: 'CLIPTextEncode', inputs: { text: 'placeholder' } },
      '3': { class_type: 'KSampler', inputs: { seed: 0 } },
    },
    params: [
      { name: 'prompt', type: 'text', target: { node: '6', input: 'text' } },
      { name: 'seed', type: 'seed', targets: [{ node: '3', input: 'seed' }] },
    ],
    cost: 3,
  }
  let cf: Awaited<ReturnType<typeof seedOauthKey>>

  beforeEach(async () => {
    const [flock] = await db.insert(schema.flock).values({ orgId: fx.orgId, breed: 'comfyui', name: 'gpu', baseUrl: 'http://fake.comfyui' }).returning()
    const [paddock] = await db.insert(schema.paddock).values({ orgId: fx.orgId, flockId: flock!.id, slug: 'cf', name: 'Images' }).returning()
    await db.insert(schema.fence).values({ orgId: fx.orgId, paddockId: paddock!.id, constraintJson: { templates: [txt2img] }, rateLimit: { windowSec: 60, max: 100 }, quota: null })
    cf = await seedOauthKey(db, fx, { paddockId: paddock!.id })
  })
  const cfCall = (name: string, args: unknown, key = cf) => call(name, args, 'cf', { token: tokenFor(key, 'cf') })

  test('run, then get_job_result: pending, then the images as base64 image content, metered once', async () => {
    const run = await cfCall('run_txt2img', { prompt: 'a cat' })
    expect(run.body.result.structuredContent).toEqual({ job_id: 'cf-1' })
    expect((await cfCall('get_job_result', { job_id: 'cf-1' })).body.result.content)
      .toEqual([{ type: 'text', text: 'Job still running. Call again later.' }])

    comfy.complete('cf-1')
    const done = await cfCall('get_job_result', { job_id: 'cf-1' })
    const png = Buffer.from(FAKE_PNG).toString('base64')
    expect(done.body.result.content).toEqual([
      { type: 'text', text: 'Job finished with 2 images.' },
      { type: 'image', data: png, mimeType: 'image/png' },
      { type: 'image', data: png, mimeType: 'image/png' },
    ])
    await cfCall('get_job_result', { job_id: 'cf-1' })
    await drainMeters()
    const dims = sink.events.filter((e) => e.keyId === cf.keyId).map((e) => [e.dim, e.value])
    expect(dims).toEqual([['jobs', 3], ['images', 2], ['gpu_ms', 500]])
  })

  test('another grant\'s key cannot see the job', async () => {
    await cfCall('run_txt2img', { prompt: 'a cat' })
    const [p] = await db.select().from(schema.paddock).where(eq(schema.paddock.slug, 'cf'))
    const other = await seedOauthKey(db, fx, { paddockId: p!.id, clientId: 'https://other.example/client.json' })
    expect((await cfCall('get_job_result', { job_id: 'cf-1' }, other)).body.result).toMatchObject({ content: [{ type: 'text', text: 'not found' }], isError: true })
  })

  test('images over the per-result cap are isError naming the cap', async () => {
    build({ mcp: { dataPlaneUrl: DP, oidcIssuer: op.issuer, verify: op.verifier, maxImageBytes: 10 } })
    await cfCall('run_txt2img', { prompt: 'a cat' })
    comfy.complete('cf-1')
    const r = (await cfCall('get_job_result', { job_id: 'cf-1' })).body.result
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('10-byte limit')
  })

  test('an undeclared parameter is refused by reconstructGraph, as isError', async () => {
    const r = (await cfCall('run_txt2img', { prompt: 'a', graph: {} })).body.result
    expect(r.isError).toBe(true)
    expect(upstreamCalls.filter((u) => u.endsWith('/prompt'))).toEqual([])
  })
})
```

- [ ] **Step 4: Run them to verify they fail**

Run: `pnpm exec vitest run apps/data-plane/test/mcp-protocol.test.ts apps/data-plane/test/mcp.integration.test.ts`
Expected: FAIL — `../src/mcp/jsonrpc.js` and `../src/mcp/protocol.js` do not exist.

- [ ] **Step 5: Factor out the pipeline**

Create `apps/data-plane/src/pipeline.ts`:

```ts
import type {
  Breed, BreedIO, BreedRegistry, JobStore, MeterEvent, RequestCtx, RewrittenRequest, UpstreamResult,
} from '@metamodels/connectors'
import { parseHistory } from '@metamodels/connectors'
import type { ConfigStore } from './config/config-store.js'
import { quotaSchema } from './config/quota.js'
import type { RateLimit, ResolvedKey, ResolvedPaddock } from './config/types.js'
import type { MeterEventRecord, MeterSink } from './meter/meter-sink.js'
import type { UsageReader } from './meter/usage-reader.js'
import { proxyToUpstream, rawToUpstream, type FetchImpl } from './proxy/proxy.js'
import type { RateLimiter } from './ratelimit/rate-limiter.js'

/** An authenticated caller, the paddock it may use, and that paddock's breed. */
export interface Scope {
  resolvedKey: ResolvedKey
  paddock: ResolvedPaddock
  breed: Breed<unknown>
}

/** A gate's refusal, before it is rendered: the proxy sends it as JSON, MCP as `isError`. */
export interface Refusal {
  status: number
  body: Record<string, unknown>
  headers?: Record<string, string>
}

/** The short reason a refusal carries — the string the proxy returns as `error`. */
export function refusalReason(r: Refusal): string {
  return typeof r.body.error === 'string' ? r.body.error : `refused (${r.status})`
}

export type BreedOutcome =
  | { kind: 'refused'; refusal: Refusal }
  | { kind: 'handled'; status: number; body: unknown }
  | { kind: 'proxied'; response: Response; metering: Promise<UpstreamResult> }

export interface PipelineDeps {
  configStore: ConfigStore
  rateLimiter: RateLimiter
  meterSink: MeterSink
  registry: BreedRegistry
  jobStore: JobStore
  usageReader?: UsageReader
  fetchImpl?: FetchImpl
  defaultRateLimit?: RateLimit
}

/**
 * The gates every request to a paddock passes after its caller is authenticated, shared by the
 * streaming proxy (`ALL /p/:slug/*`, `GET /p/:slug/result/:jobId`) and MCP (`POST /p/:slug/mcp`), so
 * that "inherited unchanged" (spec M4 §2) is true by construction rather than by copy.
 */
export interface Pipeline {
  /** Unknown or inactive paddock 404; key not scoped 403; unopenable upstream credential 503. */
  paddockScope(resolvedKey: ResolvedKey, slug: string): Promise<{ ok: true; scope: Scope } | { ok: false; refusal: Refusal }>
  /** Rate limit, then quota. Null when the request may proceed. */
  limits(scope: Scope): Promise<Refusal | null>
  /** `guard()` then `handle` or `proxyToUpstream`, then `meter`. A transport failure to upstream throws, as before. */
  run(scope: Scope, ctx: RequestCtx): Promise<BreedOutcome>
  /** The scoped result view of one of this key's jobs on this paddock; meters images and gpu_ms once. */
  jobResult(scope: Scope, jobId: string): Promise<{ status: number; body: unknown }>
  /** A raw call to the paddock's flock with its credential (`/view` for MCP image bytes). */
  raw(scope: Scope, path: string, init: RequestInit): Promise<Response>
  /** Resolves once every in-flight meter emission has settled. */
  drain(): Promise<void>
}

const DEFAULT_RATE_LIMIT: RateLimit = { windowSec: 60, max: 60 }

export function createPipeline(deps: PipelineDeps): Pipeline {
  const defaultLimit = deps.defaultRateLimit ?? DEFAULT_RATE_LIMIT
  const pending = new Set<Promise<void>>()

  function track(task: Promise<void>): Promise<void> {
    pending.add(task)
    task.finally(() => pending.delete(task))
    return task
  }

  // Emit meter events, scoped to a paddock, through the drainable mechanism so
  // tests can await completion deterministically. Errors are swallowed (metering
  // is best-effort and must never fail the request).
  function emitScoped(scope: Scope, events: MeterEvent[]): Promise<void> {
    if (events.length === 0) return Promise.resolve()
    const { resolvedKey, paddock } = scope
    const records: MeterEventRecord[] = events.map((e) => ({
      orgId: paddock.orgId,
      keyId: resolvedKey.keyId,
      paddockId: paddock.paddockId,
      breedId: paddock.breedId,
      dim: e.dim,
      value: e.value,
      at: e.at,
    }))
    return track(deps.meterSink.emit(records).catch(() => undefined).then(() => undefined))
  }

  // Build the capability surface handed to a breed's `handle` hook.
  function buildIo(scope: Scope): BreedIO {
    const { resolvedKey, paddock } = scope
    return {
      ids: { orgId: paddock.orgId, keyId: resolvedKey.keyId, paddockId: paddock.paddockId },
      flock: paddock.flock,
      async upstream(req: RewrittenRequest): Promise<UpstreamResult> {
        // Normalize a transport failure into a 502 so an unguarded breed call
        // can never surface as an unhandled 500.
        try {
          const { metering } = await proxyToUpstream(paddock.flock, req, { fetchImpl: deps.fetchImpl })
          return await metering
        } catch {
          return { status: 502, headers: {}, body: undefined, finalFrame: undefined }
        }
      },
      upstreamRaw(path: string, init: RequestInit): Promise<Response> {
        return rawToUpstream(paddock.flock, path, init, { fetchImpl: deps.fetchImpl })
      },
      emitMeter: (events) => emitScoped(scope, events),
      jobs: deps.jobStore,
    }
  }

  return {
    async paddockScope(resolvedKey, slug) {
      const paddock = await deps.configStore.getPaddockBySlug(slug)
      if (!paddock || paddock.status !== 'active') return { ok: false, refusal: { status: 404, body: { error: 'unknown paddock' } } }
      if (!resolvedKey.paddockSlugs.includes(slug)) {
        return { ok: false, refusal: { status: 403, body: { error: 'key not scoped to paddock' } } }
      }
      // Fail closed, and only now: behind the key and scope gates, so only a caller entitled to this
      // paddock learns its credential is broken. Forwarding without it would turn a key problem into
      // an upstream 401 that points everyone at the wrong system.
      if (paddock.upstreamAuthError) {
        return { ok: false, refusal: { status: 503, body: { error: 'upstream credential unavailable' } } }
      }
      return { ok: true, scope: { resolvedKey, paddock, breed: deps.registry.get(paddock.breedId) } }
    },

    async limits({ resolvedKey, paddock }) {
      const limit = resolvedKey.overrides?.rateLimit ?? paddock.fence.rateLimit ?? defaultLimit
      const rl = await deps.rateLimiter.check(`${resolvedKey.keyId}:${paddock.paddockId}`, limit)
      if (!rl.allowed) {
        return { status: 429, body: { error: 'rate limit exceeded' }, headers: { 'retry-after': String(rl.retryAfterSec) } }
      }

      // Quota caps (hard). Read the current period's rollup total per rule and
      // reject at/over the cap. Enforced against already-aggregated usage, so a
      // single in-flight request may cross the cap before it is counted
      // (bounded by worker lag) — acceptable for v1; see Plan 4 carry-forward.
      if (deps.usageReader && paddock.fence.quota != null) {
        const parsed = quotaSchema.safeParse(paddock.fence.quota)
        // Fail-open by design: a malformed quota disables the cap for this request rather than
        // 500ing it — a misconfigured fence must not take the data plane down.
        if (parsed.success) {
          const now = Date.now()
          for (const rule of parsed.data) {
            const used = await deps.usageReader.periodUsage(resolvedKey.keyId, paddock.paddockId, rule.dim, rule.period, now)
            if (used >= rule.max) return { status: 429, body: { error: 'quota exceeded', dim: rule.dim } }
          }
        }
      }
      return null
    },

    async run(scope, ctx) {
      const { paddock, breed } = scope
      const fence = breed.constraintSchema.parse(paddock.fence.constraintJson)

      // Breeds that own a multi-step flow implement `handle`. Delegate the
      // entire request to it — EXCEPT a request that targets one of the breed's
      // declared direct upstream routes (all exposeByDefault:false). Those are
      // bypass attempts and must be denied by `guard` (defense in depth), so a
      // consumer can never reach a raw upstream endpoint (e.g. /prompt) directly.
      if (breed.handle) {
        const direct = breed.routes.find(
          (r) => r.method === ctx.method && !r.exposeByDefault && (ctx.path === r.path || ctx.path.startsWith(r.path + '/')),
        )
        if (direct) {
          const guard = await breed.guard(ctx, fence)
          if (!guard.ok) return { kind: 'refused', refusal: { status: guard.status, body: { error: guard.reason } } }
        }
        const result = await breed.handle(ctx, fence, buildIo(scope))
        return { kind: 'handled', status: result.status, body: result.body }
      }

      // Generic path (Ollama): guard → proxy → meter.
      const guard = await breed.guard(ctx, fence)
      if (!guard.ok) return { kind: 'refused', refusal: { status: guard.status, body: { error: guard.reason } } }

      const { response, metering } = await proxyToUpstream(paddock.flock, guard.request, { fetchImpl: deps.fetchImpl })
      track(metering.then((upstream) => emitScoped(scope, breed.meter(ctx, upstream))).catch(() => undefined).then(() => undefined))
      return { kind: 'proxied', response, metering }
    },

    // Consumers poll their own job by id and receive a scoped `{ done, images }` view — never the raw
    // /history payload or a direct /view URL. A job belonging to another key returns 404 (not 403) so
    // it does not leak the existence of other keys' jobs.
    async jobResult(scope, jobId) {
      const { resolvedKey, paddock } = scope
      const job = await deps.jobStore.get(jobId)
      if (!job || job.keyId !== resolvedKey.keyId || job.paddockId !== paddock.paddockId) {
        return { status: 404, body: { error: 'not found' } }
      }

      // Fetch the upstream history for this job (server-side only; never exposed).
      let historyBody: unknown
      try {
        const { metering } = await proxyToUpstream(
          paddock.flock,
          { method: 'GET', path: `/history/${jobId}`, headers: {}, body: undefined },
          { fetchImpl: deps.fetchImpl },
        )
        historyBody = (await metering).body
      } catch {
        historyBody = undefined
      }

      const outcome = parseHistory(historyBody, jobId)

      // Meter images + gpu_ms exactly once, at completion. markMetered is a
      // compare-and-set: mark BEFORE emitting and emit only when this poll won the
      // transition, so concurrent polls can never double-meter (only one wins).
      if (outcome.done && (await deps.jobStore.markMetered(jobId))) {
        const at = Date.now()
        await emitScoped(scope, [
          { dim: 'images', value: outcome.images.length, at },
          { dim: 'gpu_ms', value: outcome.gpuMs, at },
        ])
      }
      return { status: 200, body: { done: outcome.done, images: outcome.images } }
    },

    raw(scope, path, init) {
      return rawToUpstream(scope.paddock.flock, path, init, { fetchImpl: deps.fetchImpl })
    },

    async drain() {
      await Promise.all([...pending])
    },
  }
}
```

- [ ] **Step 6: Rewrite `app.ts` on the pipeline**

It imports `./mcp/endpoint.js`, written in Step 8; the suites run in Step 9.

Replace `apps/data-plane/src/app.ts` entirely:

```ts
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { RequestCtx } from '@metamodels/connectors'
import { hashApiKey } from '@metamodels/schema'
import type { ResolvedKey } from './config/types.js'
import { registerMcpRoutes, type McpDeps } from './mcp/endpoint.js'
import { createPipeline, type PipelineDeps, type Refusal } from './pipeline.js'
import { unauthorizedKey } from './unauthorized.js'

export interface AppDeps extends PipelineDeps {
  readiness?: () => Promise<boolean>
  /** The MCP endpoint (M4). Absent: `/p/:slug/mcp` answers 404, and the proxy still never sees it. */
  mcp?: McpDeps
}

function extractKey(header: string | undefined, xApiKey: string | undefined): string | null {
  // The scheme is case-insensitive (RFC 9110 §11.1), as in the admin API's bearer match.
  const bearer = header ? /^Bearer +(.+)$/i.exec(header) : null
  if (bearer) return bearer[1]!.trim()
  if (xApiKey) return xApiKey.trim()
  return null
}

/**
 * Applied to every response, including errors and 404s.
 *
 * This process relays bodies from upstream servers we do not control, so `nosniff` is the
 * one that earns its place: it stops a browser from re-interpreting a relayed body as
 * markup or script. HSTS is inert over plain HTTP (so LAN deployments are unaffected) and
 * takes effect the moment an operator puts the proxy behind TLS. There is no HTML surface
 * here, so no CSP — the control plane sets a nonce policy for that.
 */
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Strict-Transport-Security': 'max-age=63072000',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
}

function reply(c: Context, r: Refusal): Response {
  for (const [k, v] of Object.entries(r.headers ?? {})) c.header(k, v)
  return c.json(r.body, r.status as ContentfulStatusCode)
}

export function createApp(deps: AppDeps): { app: Hono; drainMeters: () => Promise<void> } {
  const app = new Hono()

  // Registered first so it wraps every route below, plus the framework's own 404 handler.
  app.use('*', async (c, next) => {
    await next()
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) c.header(key, value)
  })

  // Liveness: the process is up and serving. Cheap, dependency-free.
  app.get('/healthz', (c) => c.json({ status: 'ok' }))

  // Readiness: dependencies (DB, Redis) are reachable. 503 until they are.
  app.get('/readyz', async (c) => {
    if (!deps.readiness) return c.json({ ready: true })
    try {
      return (await deps.readiness()) ? c.json({ ready: true }) : c.json({ ready: false }, 503)
    } catch {
      return c.json({ ready: false }, 503)
    }
  })

  const pipeline = createPipeline(deps)

  // The proxy's credential: an `mm_live_` key, and nothing else (spec M4 §2). Every arm goes through
  // `unauthorizedKey`: it attaches the challenge RFC 9110 §15.5.2 requires, and collapses the two
  // refused-key reasons into one body so a 401 cannot grade a `mm_live_` guess. See `unauthorized.ts`.
  async function liveKey(c: Context): Promise<{ ok: true; key: ResolvedKey } | { ok: false; res: Response }> {
    const plaintext = extractKey(c.req.header('authorization'), c.req.header('x-api-key'))
    if (!plaintext) return { ok: false, res: unauthorizedKey('no key presented') }
    const key = await deps.configStore.resolveKeyByHash(hashApiKey(plaintext))
    if (!key) return { ok: false, res: unauthorizedKey('no key matches the presented hash') }
    if (key.expiresAt && key.expiresAt.getTime() < Date.now()) {
      return { ok: false, res: unauthorizedKey('the presented key has expired') }
    }
    return { ok: true, key }
  }

  // Before the catch-all, so `/p/:slug/mcp` is never proxied (spec M4 §4.1).
  registerMcpRoutes(app, { pipeline, configStore: deps.configStore, mcp: deps.mcp })

  // Scoped result route: see `Pipeline.jobResult`.
  app.get('/p/:slug/result/:jobId', async (c) => {
    const auth = await liveKey(c)
    if (!auth.ok) return auth.res
    const gate = await pipeline.paddockScope(auth.key, c.req.param('slug'))
    if (!gate.ok) return reply(c, gate.refusal)
    const out = await pipeline.jobResult(gate.scope, c.req.param('jobId'))
    return c.json(out.body as Record<string, unknown>, out.status as ContentfulStatusCode)
  })

  app.all('/p/:slug/*', async (c) => {
    const slug = c.req.param('slug')
    const upstreamPath = '/' + c.req.path.split('/').slice(3).join('/')

    // 1-2. Authenticate + resolve paddock + scope check.
    const auth = await liveKey(c)
    if (!auth.ok) return auth.res
    const gate = await pipeline.paddockScope(auth.key, slug)
    if (!gate.ok) return reply(c, gate.refusal)

    // 3. Rate limit, then quota.
    const limited = await pipeline.limits(gate.scope)
    if (limited) return reply(c, limited)

    // 4. Parse body + build context
    const contentType = c.req.header('content-type') ?? ''
    let body: unknown
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      body = contentType.includes('application/json')
        ? await c.req.json().catch(() => undefined)
        : await c.req.text().catch(() => undefined)
    }
    const ctx: RequestCtx = {
      method: c.req.method,
      path: upstreamPath,
      headers: contentType ? { 'content-type': contentType } : {},
      body,
      paddockSlug: slug,
    }

    // 5-7. guard → handle or proxy → meter.
    const out = await pipeline.run(gate.scope, ctx)
    if (out.kind === 'refused') return reply(c, out.refusal)
    if (out.kind === 'handled') return c.json(out.body as Record<string, unknown>, out.status as ContentfulStatusCode)
    return out.response
  })

  return { app, drainMeters: () => pipeline.drain() }
}
```

- [ ] **Step 7: Write JSON-RPC, the protocol rules and the image fetch**

Create `apps/data-plane/src/mcp/jsonrpc.ts`:

```ts
/** Modern revisions: version, identity and capabilities per request in `_meta` (2026-07-28 versioning §Terminology). */
export const MODERN_PROTOCOL_VERSIONS: readonly string[] = ['2026-07-28']
/** Legacy revisions served statelessly (D9), newest first: `initialize` answers the first when it cannot echo. */
export const LEGACY_PROTOCOL_VERSIONS: readonly string[] = ['2025-11-25', '2025-06-18']
/** What `server/discover` and `-32022` advertise: every version this dual-era endpoint serves. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [...MODERN_PROTOCOL_VERSIONS, ...LEGACY_PROTOCOL_VERSIONS]

export const PROTOCOL_VERSION_META = 'io.modelcontextprotocol/protocolVersion'
export const SERVER_INFO_META = 'io.modelcontextprotocol/serverInfo'
export const MCP_SERVER_NAME = 'metamodels'
/**
 * `serverInfo.version`. The stack exposes no version of its own (every package.json says 0.0.0 and
 * nothing reads one), so this is that literal rather than new build plumbing.
 */
export const MCP_SERVER_VERSION = '0.0.0'
/**
 * `ttlMs` on the cacheable modern results (`CacheableResult.ttlMs` is required by the 2026-07-28 schema).
 * 0 = immediately stale: tools are derived from the fence, and a fence edit must show on the next list.
 */
export const MCP_CACHE_TTL_MS = 0

export const JSONRPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** 2026-07-28 `HEADER_MISMATCH`. */
  headerMismatch: -32020,
  /** 2026-07-28 `UNSUPPORTED_PROTOCOL_VERSION`. */
  unsupportedProtocolVersion: -32022,
} as const

export type JsonRpcId = string | number

export type JsonRpcMessage =
  | { kind: 'request'; id: JsonRpcId; method: string; params: unknown }
  | { kind: 'notification'; method: string }
  | { kind: 'invalid'; id: JsonRpcId | null; message: string }

const invalid = (id: JsonRpcId | null, message: string): JsonRpcMessage => ({ kind: 'invalid', id, message })

/** One JSON-RPC 2.0 message, already `JSON.parse`d. Arrays (batches) are refused. */
export function parseJsonRpc(raw: unknown): JsonRpcMessage {
  if (Array.isArray(raw)) return invalid(null, 'batch requests are not supported')
  if (typeof raw !== 'object' || raw === null) return invalid(null, 'expected a JSON-RPC 2.0 object')
  const m = raw as Record<string, unknown>
  const id = typeof m.id === 'string' || (typeof m.id === 'number' && Number.isFinite(m.id)) ? m.id : null
  if (m.jsonrpc !== '2.0') return invalid(id, 'jsonrpc must be "2.0"')
  if (typeof m.method !== 'string') return invalid(id, 'method must be a string')
  if (!('id' in m)) return { kind: 'notification', method: m.method }
  if (id === null) return invalid(null, 'id must be a string or a number')
  if (m.params !== undefined && (typeof m.params !== 'object' || m.params === null)) {
    return invalid(id, 'params must be an object or an array')
  }
  return { kind: 'request', id, method: m.method, params: m.params }
}

export function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: '2.0' as const, id, result }
}

export function rpcError(id: JsonRpcId | null, code: number, message: string, data?: unknown) {
  return { jsonrpc: '2.0' as const, id, error: { code, message, ...(data === undefined ? {} : { data }) } }
}
```

Create `apps/data-plane/src/mcp/protocol.ts`:

```ts
import {
  JSONRPC_ERRORS, LEGACY_PROTOCOL_VERSIONS, MODERN_PROTOCOL_VERSIONS, PROTOCOL_VERSION_META, rpcError,
  SUPPORTED_PROTOCOL_VERSIONS, type JsonRpcId,
} from './jsonrpc.js'

export type Era = 'modern' | 'legacy'

/** A header lookup by lower-case name (Hono's `c.req.header`). */
export type HeaderLookup = (name: string) => string | undefined

export interface HttpRpcError {
  status: 400
  body: ReturnType<typeof rpcError>
}

const SENTINEL_PREFIX = '=?base64?'
const SENTINEL_SUFFIX = '?='

/**
 * A header value as the body would hold it (2026-07-28 streamable-http §Value Encoding): the Base64
 * sentinel `=?base64?…?=` decoded as UTF-8, a plain value as itself. Null for a value with characters
 * RFC 9110 does not allow in a field value, or a sentinel whose payload is not Base64 — both are
 * validation failures.
 */
export function decodeHeaderValue(value: string): string | null {
  if (value.startsWith(SENTINEL_PREFIX) && value.endsWith(SENTINEL_SUFFIX) && value.length >= SENTINEL_PREFIX.length + SENTINEL_SUFFIX.length) {
    const payload = value.slice(SENTINEL_PREFIX.length, value.length - SENTINEL_SUFFIX.length)
    return /^[A-Za-z0-9+/]*={0,2}$/.test(payload) ? Buffer.from(payload, 'base64').toString('utf8') : null
  }
  return /^[\x20-\x7e\t]*$/.test(value) ? value : null
}

/** `params._meta["io.modelcontextprotocol/protocolVersion"]`, or undefined when there is none. */
export function metaVersion(params: unknown): unknown {
  const meta = (params as { _meta?: unknown } | null | undefined)?._meta
  return typeof meta === 'object' && meta !== null ? (meta as Record<string, unknown>)[PROTOCOL_VERSION_META] : undefined
}

/**
 * Which era a request belongs to (D9; 2026-07-28 versioning §Backward Compatibility: "A request carrying
 * modern per-request `_meta` is served statelessly according to this revision. An `initialize` request
 * selects legacy semantics"). A request with no `_meta` version is legacy only when its
 * `MCP-Protocol-Version` header names a legacy version this server serves; anything else is held to
 * the modern rules, so a request with neither is refused for the missing header rather than guessed at.
 */
export function eraOf(method: string, params: unknown, headerVersion: string | undefined): Era {
  if (method === 'initialize') return 'legacy'
  if (metaVersion(params) === undefined && headerVersion !== undefined && LEGACY_PROTOCOL_VERSIONS.includes(headerVersion)) return 'legacy'
  return 'modern'
}

/** 2025-11-25 lifecycle §Version Negotiation: the requested version if supported, else the latest this server supports. */
export function legacyNegotiatedVersion(requested: unknown): string {
  return typeof requested === 'string' && LEGACY_PROTOCOL_VERSIONS.includes(requested) ? requested : LEGACY_PROTOCOL_VERSIONS[0]!
}

/**
 * 2026-07-28 streamable-http §Server Validation, for a modern request: the three standard headers must
 * be present and match the body (`Mcp-Name` only for `tools/call`, the one such method served here),
 * and the version they agree on must be one this server implements. Returns the 400 to send, or null.
 */
export function validateModern(id: JsonRpcId, method: string, params: unknown, header: HeaderLookup): HttpRpcError | null {
  const mismatch = (message: string): HttpRpcError => ({ status: 400, body: rpcError(id, JSONRPC_ERRORS.headerMismatch, `Header mismatch: ${message}`) })

  const version = header('mcp-protocol-version')
  if (version === undefined) return mismatch('the MCP-Protocol-Version header is required')
  const bodyVersion = metaVersion(params)
  if (typeof bodyVersion !== 'string' || bodyVersion !== version) {
    return mismatch(`MCP-Protocol-Version does not match params._meta["${PROTOCOL_VERSION_META}"]`)
  }
  if (!MODERN_PROTOCOL_VERSIONS.includes(version)) {
    return {
      status: 400,
      body: rpcError(id, JSONRPC_ERRORS.unsupportedProtocolVersion, 'Unsupported protocol version', {
        supported: [...SUPPORTED_PROTOCOL_VERSIONS], requested: version,
      }),
    }
  }

  const mcpMethod = header('mcp-method')
  if (mcpMethod === undefined) return mismatch('the Mcp-Method header is required')
  if (mcpMethod !== method) return mismatch('Mcp-Method does not match the body method')

  if (method === 'tools/call') {
    const raw = header('mcp-name')
    if (raw === undefined) return mismatch('the Mcp-Name header is required for tools/call')
    const name = decodeHeaderValue(raw)
    if (name === null || name !== (params as { name?: unknown } | null | undefined)?.name) {
      return mismatch('Mcp-Name does not match params.name')
    }
  }
  return null
}

/**
 * A legacy request. `initialize` carries no header (2025-11-25 transports: the header is sent "on all
 * subsequent requests"), but one it does carry must name a version this server serves (2025-11-25:
 * an unsupported `MCP-Protocol-Version` MUST get 400). Any other legacy request reached here through
 * `eraOf`, so its header already names a supported legacy version.
 */
export function validateLegacy(id: JsonRpcId, method: string, header: HeaderLookup): HttpRpcError | null {
  const version = header('mcp-protocol-version')
  if (method === 'initialize' && version !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
    return { status: 400, body: rpcError(id, JSONRPC_ERRORS.invalidRequest, `unsupported MCP-Protocol-Version; supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}`) }
  }
  return null
}
```

Create `apps/data-plane/src/mcp/job-images.ts`:

```ts
import type { JobResultImage } from '@metamodels/connectors'

/**
 * The most image bytes one `get_job_result` returns inline (spec M4 §3.8: there was no cap to reuse).
 * Base64 grows it by a third, so one JSON-RPC response stays under ~11 MB.
 */
export const MCP_MAX_IMAGE_BYTES = 8 * 1024 * 1024

type Attached = { ok: true; body: { done: boolean; images: JobResultImage[] } } | { ok: false; error: string }

const tooBig = (cap: number): Attached => ({ ok: false, error: `the job's images exceed the ${cap}-byte limit for one MCP result` })
const unfetchable: Attached = { ok: false, error: 'an output image could not be fetched' }

/** Read a body, giving up (and cancelling) as soon as it passes `remaining` bytes. */
async function readCapped(res: Response, remaining: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > remaining) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/**
 * Turn the scoped result view's image references into bytes, fetched from the flock's `/view` with
 * its credential. Only for a finished job; all-or-nothing, so a result never silently drops an image.
 */
export async function attachImageBytes(body: unknown, view: (path: string) => Promise<Response>, cap: number): Promise<Attached> {
  const b = body as { done?: unknown; images?: unknown } | null
  const images = (Array.isArray(b?.images) ? b.images : []) as JobResultImage[]
  if (b?.done !== true) return { ok: true, body: { done: false, images } }

  let total = 0
  const out: JobResultImage[] = []
  for (const img of images) {
    const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder, type: img.type })
    let res: Response
    try {
      res = await view(`/view?${q}`)
    } catch {
      return unfetchable
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined)
      return unfetchable
    }
    const declared = Number(res.headers.get('content-length') ?? '0')
    if (declared > cap - total) {
      await res.body?.cancel().catch(() => undefined)
      return tooBig(cap)
    }
    const bytes = await readCapped(res, cap - total)
    if (bytes === null) return tooBig(cap)
    total += bytes.length
    const mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png'
    out.push({ ...img, data: Buffer.from(bytes).toString('base64'), mimeType })
  }
  return { ok: true, body: { done: true, images: out } }
}
```

- [ ] **Step 8: Write the endpoint**

Create `apps/data-plane/src/mcp/endpoint.ts`:

```ts
import type { Context, Hono } from 'hono'
import { toolError, type McpCallToolResult, type McpToolDef, type RequestCtx } from '@metamodels/connectors'
import { PADDOCK_SLUG_MAX, PADDOCK_SLUG_RE } from '@metamodels/schema'
import type { ConfigStore } from '../config/config-store.js'
import { refusalReason, type Pipeline, type Scope } from '../pipeline.js'
import { authenticateMcp, type McpAuthDeps } from './auth.js'
import { attachImageBytes, MCP_MAX_IMAGE_BYTES } from './job-images.js'
import {
  JSONRPC_ERRORS, MCP_CACHE_TTL_MS, MCP_SERVER_NAME, MCP_SERVER_VERSION, parseJsonRpc, rpcError, rpcResult,
  SERVER_INFO_META, SUPPORTED_PROTOCOL_VERSIONS, type JsonRpcId,
} from './jsonrpc.js'
import { eraOf, legacyNegotiatedVersion, validateLegacy, validateModern, type Era } from './protocol.js'

export interface McpDeps extends McpAuthDeps {
  /** `OIDC_ISSUER`: the authorization server this resource names in its RFC 9728 metadata. */
  oidcIssuer: string
  /** Per-result cap on inline image bytes; defaults to `MCP_MAX_IMAGE_BYTES`. */
  maxImageBytes?: number
}

/** The one planned path answered by the scoped result view rather than by `run` (ComfyUI's `get_job_result`). */
const RESULT_PATH = /^\/result\/([^/]+)$/

/** A dispatched JSON-RPC answer and the HTTP status it goes out with. */
interface Answer {
  status: number
  body: unknown
}

const ok = (id: JsonRpcId, result: unknown): Answer => ({ status: 200, body: rpcResult(id, result) })

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

const validSlug = (slug: string) => slug.length <= PADDOCK_SLUG_MAX && PADDOCK_SLUG_RE.test(slug)

/**
 * `POST /p/:slug/mcp` (spec M4 §4, D9): stateless Streamable HTTP, one JSON-RPC message per POST,
 * answered as `application/json`, for modern (2026-07-28) and legacy (2025-11-25, 2025-06-18) clients
 * alike. Order: Origin (403) → token (401/503) → body (400) → notification (202) → era validation
 * (400) → paddock gates (404/503) → dispatch. `Mcp-Session-Id` and `Last-Event-ID` are never read and
 * no session id is ever sent. Must be registered before `ALL /p/:slug/*`.
 */
export function registerMcpRoutes(app: Hono, deps: { pipeline: Pipeline; configStore: ConfigStore; mcp?: McpDeps }): void {
  const { pipeline } = deps

  app.post('/p/:slug/mcp', async (c) => {
    const slug = c.req.param('slug')
    const mcp = deps.mcp
    if (!mcp || !validSlug(slug)) return c.json({ error: 'not found' }, 404)

    // 2026-07-28 streamable-http §Security: an Origin that is present and not ours is DNS rebinding
    // until proven otherwise. The body MAY be a JSON-RPC error with no id. No Origin is allowed.
    const origin = c.req.header('origin')
    if (origin !== undefined && origin !== new URL(mcp.dataPlaneUrl).origin) {
      return json({ jsonrpc: '2.0', error: { code: JSONRPC_ERRORS.invalidRequest, message: 'Origin not allowed' } }, 403)
    }

    const auth = await authenticateMcp(c.req.header('authorization'), slug, mcp, deps.configStore)
    if (!auth.ok) return auth.res

    let raw: unknown
    try {
      raw = JSON.parse(await c.req.text())
    } catch {
      return json(rpcError(null, JSONRPC_ERRORS.parseError, 'parse error'), 400)
    }
    const msg = parseJsonRpc(raw)
    if (msg.kind === 'invalid') return json(rpcError(msg.id, JSONRPC_ERRORS.invalidRequest, msg.message), 400)
    // Nothing here acts on a notification (`notifications/initialized`, `notifications/cancelled`…):
    // accepted with 202 and no body, in either era. 2026-07-28 defines no headers for notification POSTs.
    if (msg.kind === 'notification') return new Response(null, { status: 202 })

    const header = (name: string) => c.req.header(name)
    const era = eraOf(msg.method, msg.params, header('mcp-protocol-version'))
    const refused = era === 'modern'
      ? validateModern(msg.id, msg.method, msg.params, header)
      : validateLegacy(msg.id, msg.method, header)
    if (refused) return json(refused.body, refused.status)

    const gate = await pipeline.paddockScope(auth.key, slug)
    if (!gate.ok) return json(gate.refusal.body, gate.refusal.status, gate.refusal.headers)

    const answer = await dispatch(era, msg.id, msg.method, msg.params, gate.scope, slug, mcp)
    return json(answer.body, answer.status)
  })

  // Stateless: no SSE stream to GET, no session to DELETE (2026-07-28 streamable-http §Backward Compatibility).
  app.all('/p/:slug/mcp', (c: Context) => {
    if (!deps.mcp) return c.json({ error: 'not found' }, 404)
    c.header('allow', 'POST')
    return c.json({ error: 'method not allowed' }, 405)
  })

  async function dispatch(era: Era, id: JsonRpcId, method: string, params: unknown, scope: Scope, slug: string, mcp: McpDeps): Promise<Answer> {
    const { paddock, breed } = scope
    const fence = breed.constraintSchema.safeParse(paddock.fence.constraintJson)
    if (!fence.success) return { status: 200, body: rpcError(id, JSONRPC_ERRORS.internalError, "this paddock's fence is invalid") }
    const tools = breed.toMcp?.(fence.data) ?? []
    const call = () => toolsCall(id, params, tools, fence.data, scope, slug, mcp)
    return era === 'modern' ? modern(id, method, tools, call) : legacy(id, method, params, paddock.name, tools, call)
  }

  /** 2026-07-28: every result carries `resultType` and `serverInfo`; discover and list are cacheable, per caller. */
  async function modern(id: JsonRpcId, method: string, tools: McpToolDef[], call: () => Promise<Answer | McpCallToolResult>): Promise<Answer> {
    const _meta = { [SERVER_INFO_META]: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION } }
    switch (method) {
      case 'server/discover':
        return ok(id, {
          resultType: 'complete',
          supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
          capabilities: { tools: {} },
          _meta,
          ttlMs: MCP_CACHE_TTL_MS,
          cacheScope: 'private',
        })
      case 'tools/list':
        // No pagination: the lists are small, and a `cursor` is ignored (spec M4 §4.1).
        return ok(id, { resultType: 'complete', tools, ttlMs: MCP_CACHE_TTL_MS, cacheScope: 'private', _meta })
      case 'tools/call': {
        const out = await call()
        return 'status' in out ? out : ok(id, { resultType: 'complete', ...out, _meta })
      }
      default:
        // 2026-07-28 streamable-http §Protocol Version Header: an unimplemented method is HTTP 404 + -32601.
        return { status: 404, body: rpcError(id, JSONRPC_ERRORS.methodNotFound, `method not found: ${method}`) }
    }
  }

  /** 2025-11-25 / 2025-06-18, stateless: the handshake is answered, never remembered. */
  async function legacy(
    id: JsonRpcId, method: string, params: unknown, title: string, tools: McpToolDef[], call: () => Promise<Answer | McpCallToolResult>,
  ): Promise<Answer> {
    switch (method) {
      case 'initialize':
        return ok(id, {
          protocolVersion: legacyNegotiatedVersion((params as { protocolVersion?: unknown } | undefined)?.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, title, version: MCP_SERVER_VERSION },
        })
      case 'ping':
        return ok(id, {})
      case 'tools/list':
        return ok(id, { tools })
      case 'tools/call': {
        const out = await call()
        return 'status' in out ? out : ok(id, out)
      }
      default:
        return { status: 200, body: rpcError(id, JSONRPC_ERRORS.methodNotFound, `method not found: ${method}`) }
    }
  }

  /** Shared by both eras: a JSON-RPC error `Answer` for a call that names no tool, else the tool's result. */
  async function toolsCall(
    id: JsonRpcId, params: unknown, tools: McpToolDef[], fence: unknown, scope: Scope, slug: string, mcp: McpDeps,
  ): Promise<Answer | McpCallToolResult> {
    const p = (params ?? {}) as { name?: unknown; arguments?: unknown }
    if (typeof p.name !== 'string') return { status: 200, body: rpcError(id, JSONRPC_ERRORS.invalidParams, 'params.name must be a string') }
    if (!tools.some((t) => t.name === p.name)) return { status: 200, body: rpcError(id, JSONRPC_ERRORS.invalidParams, `Unknown tool: ${p.name}`) }
    return callTool(p.name, p.arguments ?? {}, fence, scope, slug, mcp)
  }

  async function callTool(name: string, args: unknown, fence: unknown, scope: Scope, slug: string, mcp: McpDeps): Promise<McpCallToolResult> {
    const { breed } = scope
    if (!breed.mcpCall || !breed.mcpResult) return toolError('this paddock cannot run tools')

    // Every tools/call, get_job_result included, is rate-limited and quota-checked (spec M4 §1), in either era.
    const limited = await pipeline.limits(scope)
    if (limited) return toolError(refusalReason(limited))

    const plan = breed.mcpCall(name, args, fence)
    if (!plan.ok) return toolError(plan.error)
    const shape = (r: { status: number; body: unknown }) => breed.mcpResult!(name, r)

    try {
      const result = plan.request.method === 'GET' ? RESULT_PATH.exec(plan.request.path) : null
      if (result) {
        const out = await pipeline.jobResult(scope, decodeURIComponent(result[1]!))
        if (out.status !== 200) return shape(out)
        const attached = await attachImageBytes(out.body, (path) => pipeline.raw(scope, path, { method: 'GET' }), mcp.maxImageBytes ?? MCP_MAX_IMAGE_BYTES)
        return attached.ok ? shape({ status: 200, body: attached.body }) : toolError(attached.error)
      }

      const { method, path, body } = plan.request
      const ctx: RequestCtx = {
        method, path, body, paddockSlug: slug,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
      }
      const out = await pipeline.run(scope, ctx)
      if (out.kind === 'refused') return toolError(refusalReason(out.refusal))
      if (out.kind === 'handled') return shape({ status: out.status, body: out.body })
      // The client branch of the tee is not needed: MCP answers from the metering branch. Not awaited —
      // a tee branch's cancel settles only once both branches are done.
      out.response.body?.cancel().catch(() => undefined)
      const upstream = await out.metering
      return shape({ status: upstream.status, body: upstream.body })
    } catch (e) {
      console.error(`[mcp] tools/call ${name} on ${slug}: upstream failed: ${String(e)}`)
      return toolError('the upstream could not be reached')
    }
  }
}
```

`McpToolDef` is already exported from `@metamodels/connectors` (`packages/connectors/src/mcp.ts`, M3).

- [ ] **Step 9: Run the tests to verify they pass**

Run: `pnpm exec vitest run apps/data-plane`
Expected: PASS — the new files, and every existing proxy suite unchanged (the refactor's proof).

- [ ] **Step 10: Wire the endpoint at boot**

In `apps/data-plane/src/server.ts`, import `createAccessTokenVerifier` from `@metamodels/schema/access-token`, and pass to `createApp`:

```ts
    mcp: {
      dataPlaneUrl: cfg.dataPlaneUrl,
      oidcIssuer: cfg.oidcIssuer,
      // `iss` is the public issuer; the key set is fetched over the deployment's network.
      verify: createAccessTokenVerifier({ issuer: cfg.oidcIssuer, jwksUrl: `${cfg.oidcInternalUrl}/jwks`, typ: 'at+jwt' }),
    },
```

- [ ] **Step 11: Run the whole root lane and typecheck**

Run: `pnpm test && pnpm -w exec tsc -b`
Expected: PASS; clean.

- [ ] **Step 12: Commit**

```bash
git add apps/data-plane/src apps/data-plane/test
git commit -m "feat(data-plane): serve the per-paddock MCP endpoint to modern and legacy clients through the proxy's own gate pipeline"
```

---

### Task 13: RFC 9728 on both resource servers

Spec §5. Each resource server publishes its protected-resource metadata, built from the same `@metamodels/schema/oidc.ts` helpers as the OP's resource map, and names it in its 401 challenge. The data plane's challenge already does (Task 11); the admin API's bare `Bearer` gains `resource_metadata=`. That changes four M2 assertions of the bare challenge, all updated here: `admin-route.test.ts:86`, `problem.test.ts:277`, `openapi.test.ts:329` and `apps/e2e/specs/admin-api.spec.ts:350`. No `error=` parameter is added, ever: the enumeration argument in `problem.ts:50-58` is unchanged.

**Files:**
- Modify: `packages/schema/src/oidc.ts`, `packages/schema/test/oidc.test.ts`
- Modify: `apps/data-plane/src/mcp/endpoint.ts`, `apps/data-plane/test/mcp.integration.test.ts`
- Create: `apps/control-plane/src/app/.well-known/oauth-protected-resource/api/admin/route.ts`
- Test: `apps/control-plane/src/server/admin-metadata-route.test.ts`
- Modify: `apps/control-plane/src/server/problem.ts`, `problem.test.ts`, `admin-route.test.ts`, `openapi.ts`, `openapi.test.ts`
- Modify: `docs/api/openapi.json` (regenerated), `apps/e2e/specs/admin-api.spec.ts`

**Interfaces:**
- Consumes: `mcpResource`, `protectedResourceMetadataUrl`, `requireOrigin`, `MCP_SCOPE` (Task 1); `McpDeps.oidcIssuer` (Task 12); `adminApiResource`, `CAPABILITIES` (M2); `loadOidcClientConfig` (`apps/control-plane/src/auth/oidc-client.ts:53`).
- Produces:
  - `protectedResourceMetadata(resource: string, issuer: string, scopes: readonly string[]): { resource; authorization_servers; scopes_supported; bearer_methods_supported }`
  - `GET <DATA_PLANE_URL>/.well-known/oauth-protected-resource/p/:slug/mcp` (no auth; 404 unknown or inactive)
  - `GET <CONSOLE_URL>/.well-known/oauth-protected-resource/api/admin`
  - `adminChallenge(consoleUrl?: string): string` in `problem.ts`

- [ ] **Step 1: Write the failing schema test**

Append to `packages/schema/test/oidc.test.ts` (add `protectedResourceMetadata, protectedResourceMetadataUrl` to the import):

```ts
describe('RFC 9728 metadata (M4 §5)', () => {
  test('the metadata URL inserts the well-known segment before the resource path', () => {
    expect(protectedResourceMetadataUrl('https://dp.example.test/p/small/mcp'))
      .toBe('https://dp.example.test/.well-known/oauth-protected-resource/p/small/mcp')
    expect(protectedResourceMetadataUrl('https://console.example.test/api/admin'))
      .toBe('https://console.example.test/.well-known/oauth-protected-resource/api/admin')
  })

  test('the document names the resource, its one authorization server, its scopes and header bearer only', () => {
    expect(protectedResourceMetadata('https://dp.example.test/p/small/mcp', 'https://auth.example.test', ['mcp'])).toEqual({
      resource: 'https://dp.example.test/p/small/mcp',
      authorization_servers: ['https://auth.example.test'],
      scopes_supported: ['mcp'],
      bearer_methods_supported: ['header'],
    })
  })
})
```

- [ ] **Step 2: Run it to verify it fails, then add the builder**

Run: `pnpm exec vitest run packages/schema/test/oidc.test.ts`
Expected: FAIL — `protectedResourceMetadata` is not exported.

Append to `packages/schema/src/oidc.ts`:

```ts
/**
 * An RFC 9728 protected-resource metadata document. Both resource servers build theirs here, from the
 * same resource helpers as the OP's resource map, so the issuer, resource and scopes cannot drift.
 */
export function protectedResourceMetadata(resource: string, issuer: string, scopes: readonly string[]) {
  return {
    resource,
    authorization_servers: [issuer],
    scopes_supported: [...scopes],
    bearer_methods_supported: ['header'],
  }
}
```

Run: `pnpm exec vitest run packages/schema/test/oidc.test.ts`
Expected: PASS.

- [ ] **Step 3: Write the failing data-plane test**

Append to `apps/data-plane/test/mcp.integration.test.ts`:

```ts
describe('GET /.well-known/oauth-protected-resource/p/:slug/mcp (M4 §5)', () => {
  test('is served without auth, naming the OP and the mcp scope', async () => {
    const res = await app.request(`${DP}/.well-known/oauth-protected-resource/p/small/mcp`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      resource: 'http://dp.test/p/small/mcp',
      authorization_servers: [op.issuer],
      scopes_supported: ['mcp'],
      bearer_methods_supported: ['header'],
    })
  })

  test('the challenge on a 401 points at it', async () => {
    const res = await post('small', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: null })
    const url = /resource_metadata="([^"]+)"/.exec(res.headers.get('www-authenticate') ?? '')?.[1]
    expect(url).toBe('http://dp.test/.well-known/oauth-protected-resource/p/small/mcp')
  })

  test('an unknown, inactive or malformed slug is 404', async () => {
    await db.update(schema.paddock).set({ status: 'disabled' }).where(eq(schema.paddock.id, fx.paddockId))
    for (const slug of ['small', 'ghost', 'Not_A_Slug']) {
      expect((await app.request(`${DP}/.well-known/oauth-protected-resource/p/${slug}/mcp`)).status).toBe(404)
    }
  })
})
```

- [ ] **Step 4: Run it to verify it fails, then serve it**

Run: `pnpm exec vitest run apps/data-plane/test/mcp.integration.test.ts`
Expected: FAIL — the metadata path answers 404.

In `apps/data-plane/src/mcp/endpoint.ts`, add `MCP_SCOPE, mcpResource, protectedResourceMetadata` to the `@metamodels/schema` import and register, at the top of `registerMcpRoutes`:

```ts
  // RFC 9728 §3: served without auth — there is no key to rate-limit on, and the document is static
  // per slug, read from the (cached) config. An unknown or inactive paddock is 404, as on the endpoint.
  app.get('/.well-known/oauth-protected-resource/p/:slug/mcp', async (c) => {
    const slug = c.req.param('slug')
    const mcp = deps.mcp
    if (!mcp || !validSlug(slug)) return c.json({ error: 'not found' }, 404)
    const paddock = await deps.configStore.getPaddockBySlug(slug)
    if (!paddock || paddock.status !== 'active') return c.json({ error: 'not found' }, 404)
    return c.json(protectedResourceMetadata(mcpResource(mcp.dataPlaneUrl, slug), mcp.oidcIssuer, [MCP_SCOPE]))
  })
```

Run: `pnpm exec vitest run apps/data-plane`
Expected: PASS.

- [ ] **Step 5: Write the failing control-plane tests**

Create `apps/control-plane/src/server/admin-metadata-route.test.ts` (the route lives under `.well-known`, a dot directory the lane's `src/**/*.test.ts` glob does not descend into, so its test sits here):

```ts
import { afterEach, describe, expect, test, vi } from 'vitest'
import { CAPABILITIES } from '@metamodels/schema'
import { GET } from '../app/.well-known/oauth-protected-resource/api/admin/route'

afterEach(() => { vi.unstubAllEnvs() })

describe('GET /.well-known/oauth-protected-resource/api/admin (M4 §5)', () => {
  test('names the admin API resource, the OP and every capability as a scope', async () => {
    vi.stubEnv('OIDC_ISSUER', 'https://auth.example.test')
    vi.stubEnv('CONSOLE_URL', 'https://console.example.test')
    vi.stubEnv('CONSOLE_CLIENT_SECRET', 'x'.repeat(16))
    const res = GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      resource: 'https://console.example.test/api/admin',
      authorization_servers: ['https://auth.example.test'],
      scopes_supported: [...CAPABILITIES],
      bearer_methods_supported: ['header'],
    })
  })
})
```

In `apps/control-plane/src/server/problem.test.ts`, replace the test at line 274 with:

```ts
  test('the 401 carries the Bearer challenge naming the admin API\'s metadata, and no error parameter', () => {
    vi.stubEnv('CONSOLE_URL', 'https://console.example.test')
    try {
      const res = problemForError(new TokenError('subject is not an active user'))
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate'))
        .toBe('Bearer resource_metadata="https://console.example.test/.well-known/oauth-protected-resource/api/admin"')
      expect(res.headers.get('www-authenticate')).not.toContain('error')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  test('without CONSOLE_URL the challenge falls back to the bare scheme, never to a malformed one', () => {
    vi.stubEnv('CONSOLE_URL', '')
    try {
      expect(problemForError(new TokenError('x')).headers.get('www-authenticate')).toBe('Bearer')
    } finally {
      vi.unstubAllEnvs()
    }
  })
```

In `apps/control-plane/src/server/admin-route.test.ts`, replace the test at line 84 with:

```ts
  test('the no-credential 401 carries the Bearer challenge with resource_metadata and no error', async () => {
    vi.stubEnv('CONSOLE_URL', 'https://console.test')
    try {
      const res = await call({})
      expect(res.headers.get('www-authenticate'))
        .toBe('Bearer resource_metadata="https://console.test/.well-known/oauth-protected-resource/api/admin"')
      expect(res.headers.get('www-authenticate')).not.toContain('error')
    } finally {
      vi.unstubAllEnvs()
    }
  })
```

In `apps/control-plane/src/server/openapi.test.ts`, replace the test at line 325 with:

```ts
  test('the 401 carries the Bearer challenge with resource_metadata, and no error= parameter', () => {
    const res = doc.components.responses.Unauthorized!
    // An exact equality, not a subset match: the pattern IS the claim, and `toMatchObject` would pass
    // just as happily against a schema that also allowed an `error=` parameter.
    expect(res.headers?.['WWW-Authenticate']?.schema).toEqual({ type: 'string', pattern: '^Bearer( resource_metadata="[^"]+")?$' })
  })
```

- [ ] **Step 6: Run them to verify they fail**

Run: `pnpm --filter @metamodels/control-plane exec vitest run --testTimeout=30000 src/server/admin-metadata-route.test.ts src/server/problem.test.ts src/server/admin-route.test.ts src/server/openapi.test.ts`
Expected: FAIL — the route module does not exist; the challenge is still bare.

- [ ] **Step 7: Implement the route and the challenge**

Create `apps/control-plane/src/app/.well-known/oauth-protected-resource/api/admin/route.ts`:

```ts
import { adminApiResource, CAPABILITIES, protectedResourceMetadata } from '@metamodels/schema'
import { loadOidcClientConfig } from '../../../../../auth/oidc-client'

// Read per request: the image is built once, with no deployment's values present.
export const dynamic = 'force-dynamic'

/** RFC 9728 metadata for the admin API (M4 §5). Public: it names the resource and its OP, nothing else. */
export function GET(): Response {
  const { issuer, consoleUrl } = loadOidcClientConfig()
  return Response.json(protectedResourceMetadata(adminApiResource(consoleUrl), issuer, CAPABILITIES))
}
```

In `apps/control-plane/src/server/problem.ts`, add `import { adminApiResource, protectedResourceMetadataUrl, requireOrigin } from '@metamodels/schema'` and replace `unauthorized`:

```ts
/**
 * The admin API's challenge: the scheme plus where to discover its authorization server (RFC 9728
 * §5.1), and nothing else. `CONSOLE_URL` is read per call, as the rest of the admin path reads it;
 * without a usable one (a unit test, a misconfigured console) it is the bare scheme, never a
 * malformed parameter.
 */
export function adminChallenge(consoleUrl: string | undefined = process.env.CONSOLE_URL): string {
  let origin: string
  try {
    origin = requireOrigin('CONSOLE_URL', consoleUrl)
  } catch {
    return 'Bearer'
  }
  return `Bearer resource_metadata="${protectedResourceMetadataUrl(adminApiResource(origin))}"`
}

/**
 * A 401 carrying the challenge RFC 9110 §15.5.2 makes MANDATORY on every 401 response — an HTTP
 * conformance rule, not an OAuth nicety.
 *
 * The scheme and `resource_metadata` (M4 §5), and nothing else. RFC 6750 §3 would let us add
 * `error="invalid_token"` versus `error="invalid_request"`, but that would restate in a header
 * precisely the distinction the `TokenError` arm's fixed `detail` refuses to make in the body,
 * reopening the enumeration oracle. Every 401 this API emits is built here, so the challenge cannot be
 * forgotten on a new 401 and an `error=` parameter cannot creep in on an old one.
 */
export function unauthorized(detail: string): Response {
  return problem(401, 'Unauthorized', detail, undefined, { 'www-authenticate': adminChallenge() })
}
```

In `apps/control-plane/src/server/openapi.ts`, in `COMPONENT_RESPONSES.Unauthorized`, replace the last sentence of the description (`` `WWW-Authenticate` ' + 'is the bare scheme for the same reason — … the body refuses to make.' ``) with:

```ts
      'account from a bad token, which would be an account-enumeration oracle. `WWW-Authenticate` ' +
      'is `Bearer` plus `resource_metadata` (RFC 9728) and nothing else, for the same reason — RFC ' +
      '6750\'s `error=` parameter would restate in a header exactly the distinction the body refuses to make.',
```

and the header object with:

```ts
        'WWW-Authenticate': {
          description: 'The challenge RFC 9110 §15.5.2 makes mandatory: `Bearer resource_metadata="<CONSOLE_URL>/.well-known/oauth-protected-resource/api/admin"`. No `error=` parameter, ever.',
          schema: { type: 'string', pattern: '^Bearer( resource_metadata="[^"]+")?$' },
        },
```

- [ ] **Step 8: Regenerate the OpenAPI document**

Run: `pnpm --filter @metamodels/control-plane gen:openapi && git diff --stat docs/api/openapi.json`
Expected: `docs/api/openapi.json` changed (the `Unauthorized` response's description and header schema).

- [ ] **Step 9: Update the e2e assertion**

In `apps/e2e/specs/admin-api.spec.ts:350`, replace `expect(noAuth.headers.get('www-authenticate')).toBe('Bearer')` with:

```ts
  expect(noAuth.headers.get('www-authenticate'))
    .toBe(`Bearer resource_metadata="${CONSOLE_URL}/.well-known/oauth-protected-resource/api/admin"`)
  const metadata = await fetch(`${CONSOLE_URL}/.well-known/oauth-protected-resource/api/admin`)
  record('RFC 9728 metadata, no Authorization header', metadata.status)
  expect(await metadata.json()).toMatchObject({ resource: `${CONSOLE_URL}/api/admin`, authorization_servers: [ISSUER] })
```

and in `apps/e2e/README.md`'s admin-api table, row 5, change ``401` with `WWW-Authenticate: Bearer`` to ``401` with `WWW-Authenticate: Bearer resource_metadata=…`, and the metadata document served without a token`.

- [ ] **Step 10: Run the tests to verify they pass**

Run: `pnpm --filter @metamodels/control-plane exec vitest run --testTimeout=30000 && pnpm test`
Expected: PASS, both lanes.

- [ ] **Step 11: Typecheck**

Run: `pnpm --filter @metamodels/control-plane build && pnpm -w exec tsc -b`
Expected: clean; the Next build lists `/.well-known/oauth-protected-resource/api/admin` among its routes.

- [ ] **Step 12: Commit**

```bash
git add packages/schema apps/data-plane apps/control-plane/src docs/api/openapi.json apps/e2e/specs/admin-api.spec.ts apps/e2e/README.md
git commit -m "feat: publish RFC 9728 metadata for the MCP endpoint and the admin API, and name it in both challenges"
```

---

### Task 14: Configuration and deployment

`DATA_PLANE_URL`, `CONTROL_PLANE_INTERNAL_URL` and the data plane's `OIDC_ISSUER` / `OIDC_INTERNAL_URL` are now required or defaulted by three services; every compose file passes them, with defaults so an existing `.env` keeps booting. `docs/DEPLOY.md` gains the variables and a *Remote MCP connectors* section (D4b: nothing becomes public by default). No hardcoded host: every default is a compose variable or a compose service name.

**Files:**
- Modify: `docker-compose.yml`, `docker-compose.deploy.yml`, `docker-compose.portainer.yml`
- Modify: `scripts/new-stack.sh`
- Modify: `docs/DEPLOY.md`

**Interfaces:**
- Consumes: the settings read by Task 4 (control plane `DATA_PLANE_URL`), Task 5 (auth `DATA_PLANE_URL`, `CONTROL_PLANE_INTERNAL_URL`), Task 11 (data plane `DATA_PLANE_URL`, `OIDC_ISSUER`, `OIDC_INTERNAL_URL`).
- Produces: nothing consumed by code.

- [ ] **Step 1: Pass the settings in `docker-compose.yml`**

In `docker-compose.yml`:
- `control-plane.environment`, after `CONSOLE_URL`:

```yaml
      # Where MCP clients reach the data plane: the console checks a consent's resource against it.
      DATA_PLANE_URL: ${DATA_PLANE_URL:-http://localhost:${DATA_PLANE_PORT:-8787}}
```

- `auth.environment`, after `CONSOLE_URL`:

```yaml
      # MCP resources are <DATA_PLANE_URL>/p/<slug>/mcp (M4); consent is recorded by the console's
      # internal route, reached over the compose network.
      DATA_PLANE_URL: ${DATA_PLANE_URL:-http://localhost:${DATA_PLANE_PORT:-8787}}
      CONTROL_PLANE_INTERNAL_URL: ${CONTROL_PLANE_INTERNAL_URL:-http://control-plane:3000}
```

- `data-plane.environment`, after `PORT`:

```yaml
      # MCP (M4): the public origin clients connect to, the issuer every access token must carry, and
      # where to fetch that issuer's keys inside the compose network.
      DATA_PLANE_URL: ${DATA_PLANE_URL:-http://localhost:${DATA_PLANE_PORT:-8787}}
      OIDC_ISSUER: ${OIDC_ISSUER}
      OIDC_INTERNAL_URL: ${OIDC_INTERNAL_URL:-http://auth:3100}
```

- [ ] **Step 2: The same in the two published-image stacks**

In `docker-compose.deploy.yml`: `control-plane.environment` gains `DATA_PLANE_URL: ${DATA_PLANE_URL:-http://localhost:${DATA_PLANE_PORT:-8787}}`; `auth.environment` gains the same line plus `CONTROL_PLANE_INTERNAL_URL: http://control-plane:3000`; `data-plane.environment` gains the same `DATA_PLANE_URL` line plus `OIDC_ISSUER: ${OIDC_ISSUER}` and `OIDC_INTERNAL_URL: http://auth:3100`. Add `DATA_PLANE_URL` to the header comment's list of variables to set (line 3).

In `docker-compose.portainer.yml`, with the loopback defaults this file uses for its other public URLs: `control-plane.environment` and `auth.environment` gain `DATA_PLANE_URL: ${DATA_PLANE_URL:-http://127.0.0.1:${DATA_PLANE_PORT:-8787}}`; `auth.environment` gains `CONTROL_PLANE_INTERNAL_URL: http://control-plane:3000`; `data-plane.environment` gains the same `DATA_PLANE_URL` line, `OIDC_ISSUER: ${OIDC_ISSUER:-http://127.0.0.1:${AUTH_HOST_PORT:-3100}}` and `OIDC_INTERNAL_URL: http://auth:3100`.

- [ ] **Step 3: Validate all three files**

Run:

```bash
for f in docker-compose.yml docker-compose.deploy.yml docker-compose.portainer.yml; do
  env -i PATH="$PATH" HOME="$HOME" CONSOLE_CLIENT_SECRET=x OIDC_COOKIE_KEYS=x OIDC_SIGNING_KEY=x UPSTREAM_AUTH_KEY=x POSTGRES_PASSWORD=x \
    docker compose -p mm-verify -f "$f" config --format json \
    | node -e 'const c=JSON.parse(require("fs").readFileSync(0,"utf8"));for(const s of ["auth","control-plane","data-plane"])console.log(process.argv[1],s,c.services[s].environment.DATA_PLANE_URL,c.services[s].environment.OIDC_ISSUER??"",c.services[s].environment.CONTROL_PLANE_INTERNAL_URL??"")' "$f"
done
```

Expected: nine lines, each with a `DATA_PLANE_URL` (`http://localhost:8787` or `http://127.0.0.1:8787`), `OIDC_ISSUER` set on every `data-plane` line, and `http://control-plane:3000` on every `auth` line. `docker compose config` only renders the files: it starts nothing, and `-p mm-verify` keeps even that away from the `metamodels` project.

- [ ] **Step 4: The stack generator**

In `scripts/new-stack.sh`, append to the `BLOCK` heredoc, after `OIDC_PREVIOUS_SIGNING_KEYS=`:

```bash
# Where MCP clients reach the data plane: <DATA_PLANE_URL>/p/<slug>/mcp. Empty means
# http://127.0.0.1:<DATA_PLANE_PORT>. See "Remote MCP connectors" in docs/DEPLOY.md.
DATA_PLANE_URL=
```

Run: `bash scripts/new-stack.sh --help >/dev/null 2>&1; bash -n scripts/new-stack.sh && echo syntax-ok`
Expected: `syntax-ok`.

- [ ] **Step 5: Document it**

In `docs/DEPLOY.md`, *Environment* table:
- change the `OIDC_ISSUER` row's services to `auth, control-plane, data-plane` and append: *The data plane requires every MCP access token to carry exactly this `iss`.*
- change the `OIDC_INTERNAL_URL` row's services to `control-plane, data-plane` and its note to: *How the console and the data plane reach the sign-in service server-to-server: `http://auth:3100` in compose. The data plane fetches the key set that verifies MCP access tokens from here. Defaults to `OIDC_ISSUER`.*
- add after `OIDC_INTERNAL_URL`:

```markdown
| `DATA_PLANE_URL` | auth, control-plane, data-plane | Public URL of the data plane, origin only. Each paddock's MCP endpoint is `<DATA_PLANE_URL>/p/<slug>/mcp`, and the sign-in service issues MCP tokens for exactly that URL, so it must be what MCP clients see. Compose defaults it to `http://localhost:<DATA_PLANE_PORT>`. |
| `CONTROL_PLANE_INTERNAL_URL` | auth | How the sign-in service reaches the console's internal routes to record an MCP app a user approved: `http://control-plane:3000` in compose (the default). |
```

In the Portainer *Variables* table, add after `OIDC_ISSUER`:

```markdown
| `DATA_PLANE_URL` | `http://127.0.0.1:<DATA_PLANE_PORT>` | Where MCP clients connect: `<DATA_PLANE_URL>/p/<slug>/mcp`. See [Remote MCP connectors](#remote-mcp-connectors) |
```

Add a section after *The two planes are not equally public*:

```markdown
### Remote MCP connectors

Each paddock is an MCP server at `<DATA_PLANE_URL>/p/<slug>/mcp`. An MCP client finds the sign-in
service from the endpoint's `401` (RFC 9728 metadata), identifies itself with a Client ID Metadata
Document, and a signed-in `member` or `admin` approves it on a consent screen. The approval appears
on the Keys page as a key of kind **OAuth**; revoking it there disconnects the app.

Nothing here is public by default. With the defaults, MCP works for clients on the same machine
(Claude Code, VS Code): the endpoint and the sign-in service are both on loopback. For a cloud
client (Claude.ai, ChatGPT), **both** must be reachable by that client over HTTPS:

- put the data plane and the sign-in service behind your TLS proxy or tunnel;
- set `DATA_PLANE_URL` and `OIDC_ISSUER` to their public `https://` origins (and restart all three
  services: each compares them exactly);
- the console does **not** need to be public. The sign-in service reaches it over the compose
  network (`CONTROL_PLANE_INTERNAL_URL`), and browsers only need it to open the Keys page.

Recording an approval is protected by a one-time `jti` check on the sign-in service's assertion.
Without `REDIS_URL` that check is per-process: run a single console container, or set `REDIS_URL`.

The sign-in service fetches each client's metadata document itself. It refuses documents on
loopback, private and other special-use addresses, and it turns Client ID Metadata Documents off
entirely when `OIDC_ISSUER` is neither `https://` nor loopback `http://`: a plain-`http` sign-in
service on a LAN address can serve the console, but not MCP clients.
```

And a short *Upgrading from 0.5.x* section above *Upgrading from 0.4.x*:

```markdown
### Upgrading from 0.5.x

Set `DATA_PLANE_URL` if clients reach the data plane anywhere other than the compose default
(`http://localhost:<DATA_PLANE_PORT>`, or `http://127.0.0.1:<DATA_PLANE_PORT>` on Portainer). The
migration adds four columns to `api_key`; every existing key becomes kind `live` and keeps working.
```

- [ ] **Step 6: Check the docs name no host of their own**

Run: `git diff -U0 docs/DEPLOY.md docker-compose*.yml scripts/new-stack.sh | grep -E '^\+' | grep -nE '192\.168\.|10\.[0-9]+\.[0-9]+\.[0-9]+|metamodels\.cc' || echo clean`
Expected: `clean`.

- [ ] **Step 7: Commit**

```bash
git add docker-compose.yml docker-compose.deploy.yml docker-compose.portainer.yml scripts/new-stack.sh docs/DEPLOY.md
git commit -m "chore(deploy): wire DATA_PLANE_URL and the MCP service URLs through every stack, and document remote connectors"
```

---

### Task 15: End to end on a throwaway stack

Spec §7. A real browser and a real OP complete CIMD → consent → token → `server/discover` → `tools/list` → `tools/call` on an Ollama paddock and a ComfyUI paddock (run, then `get_job_result`). Then a legacy client runs `initialize` → `notifications/initialized` → `tools/list` → `tools/call` against the same Ollama paddock with the same token (ruling R7). All of it runs against a fake upstream the spec runs itself, on compose project `mm-verify` with non-default ports. The CIMD document is served by an SSRF-exempt fixture wired only into the e2e OP config: the auth service loads it from `E2E_CIMD_DOCUMENTS`, and refuses to unless `OIDC_ALLOW_EPHEMERAL_KEY=true` — which every deployed stack hard-wires to `false`. Every §7 negative case is shown by command output: the browser/HTTP ones by this spec's `record()` lines, the replayed assertion and "mutate never planned" by their vitest suites.

The admin CLI helpers this spec needs (`deviceLogin` and friends) are moved out of `admin-api.spec.ts` into `specs/helpers/admin-cli.ts` unchanged, so both specs share one copy.

**Files:**
- Modify: `apps/auth/src/cimd.ts`, `apps/auth/src/server.ts`
- Test: `apps/auth/test/cimd-fixture-env.test.ts`
- Modify: `packages/schema/test/env-example.test.ts`
- Create: `apps/e2e/fixtures/mcp-client.json`, `apps/e2e/compose.mcp.yml`
- Create: `apps/e2e/specs/helpers/admin-cli.ts`; Modify: `apps/e2e/specs/admin-api.spec.ts`, `apps/e2e/specs/helpers/console.ts`
- Create: `apps/e2e/specs/mcp.spec.ts`
- Modify: `apps/e2e/README.md`, `docs/superpowers/specs/2026-09-06-remote-control-surface-design.md`

**Interfaces:**
- Consumes: `cimdFixtureFetch` (Task 5); `startAuthServer` (`apps/auth/src/server.ts:13`); every earlier task, through the running stack.
- Produces: `cimdFixtureFromEnv(path: string | undefined, allowEphemeralKey: boolean): Configuration['fetch'] | undefined`; `startAuthServer(cfg, db?, opts?: ProviderOptions)`; `adminCli(stack: { consoleUrl: string; issuer: string; homes: string[] })`; `ensureRole(browser, email, role)`.

- [ ] **Step 1: Write the failing fixture-loader test**

Create `apps/auth/test/cimd-fixture-env.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { cimdFixtureFromEnv } from '../src/cimd.js'
import { CIMD_CLIENT_ID, cimdDocument } from './helpers/flow.js'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function fixtureFile(content: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'mm-cimd-'))
  dirs.push(dir)
  const file = path.join(dir, 'clients.json')
  writeFileSync(file, JSON.stringify(content))
  return file
}

describe('cimdFixtureFromEnv (M4 §7: e2e only)', () => {
  test('unset is no fixture', () => {
    expect(cimdFixtureFromEnv(undefined, true)).toBeUndefined()
    expect(cimdFixtureFromEnv('', false)).toBeUndefined()
  })

  test('refused outright unless ephemeral keys are allowed, i.e. never in a deployed stack', () => {
    expect(() => cimdFixtureFromEnv(fixtureFile([cimdDocument()]), false)).toThrow(/E2E_CIMD_DOCUMENTS.*OIDC_ALLOW_EPHEMERAL_KEY=true/)
  })

  test('serves each listed document by its client_id', async () => {
    const fetch = cimdFixtureFromEnv(fixtureFile([cimdDocument()]), true)!
    const res = await fetch(CIMD_CLIENT_ID, { method: 'GET' } as never)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ client_id: CIMD_CLIENT_ID })
  })

  test('a file that is not an array of documents with client_id is refused at boot', () => {
    expect(() => cimdFixtureFromEnv(fixtureFile({ client_id: 'x' }), true)).toThrow(/an array of Client ID Metadata Documents/)
    expect(() => cimdFixtureFromEnv(fixtureFile([{ client_name: 'no id' }]), true)).toThrow(/an array of Client ID Metadata Documents/)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run apps/auth/test/cimd-fixture-env.test.ts`
Expected: FAIL — `cimdFixtureFromEnv` is not exported.

- [ ] **Step 3: Implement the loader and wire it at boot**

Append to `apps/auth/src/cimd.ts` (add `import { readFileSync } from 'node:fs'` at the top):

```ts
/**
 * The e2e harness's CIMD documents (spec M4 §7), from the JSON file `E2E_CIMD_DOCUMENTS` names: an
 * array of documents, each served for its own `client_id` instead of being fetched. Any other
 * `client_id` is fetched for real, through the SSRF guard. A test fixture, so it is refused outright
 * unless `OIDC_ALLOW_EPHEMERAL_KEY=true`, which every deployed stack hard-wires to `false`.
 */
export function cimdFixtureFromEnv(file: string | undefined, allowEphemeralKey: boolean): Configuration['fetch'] | undefined {
  if (!file) return undefined
  if (!allowEphemeralKey) {
    throw new Error('E2E_CIMD_DOCUMENTS is an e2e test fixture and is refused unless OIDC_ALLOW_EPHEMERAL_KEY=true')
  }
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(parsed) || !parsed.every((d) => typeof (d as { client_id?: unknown } | null)?.client_id === 'string')) {
    throw new Error(`E2E_CIMD_DOCUMENTS (${file}) must hold an array of Client ID Metadata Documents, each with a client_id`)
  }
  const documents = Object.fromEntries((parsed as ClientMetadata[]).map((d) => [d.client_id, d]))
  // eslint-disable-next-line no-console
  console.warn(`[auth] E2E_CIMD_DOCUMENTS: serving ${Object.keys(documents).length} fixture client document(s). Test stacks only.`)
  return cimdFixtureFetch(documents)
}
```

(`ClientMetadata` and `Configuration` are already imported there for `cimdFixtureFetch`.)

In `apps/auth/src/server.ts`: import `type ProviderOptions` from `./provider.js` and `cimdFixtureFromEnv` from `./cimd.js`; change the signature and the provider line of `startAuthServer`:

```ts
export function startAuthServer(
  cfg: AuthConfig,
  db: Db = drizzle(postgres(cfg.databaseUrl), { schema }),
  opts: ProviderOptions = {},
): Server {
```

```ts
  const server = createServer(createProvider(cfg, db, opts).callback())
```

and the direct-run block:

```ts
if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  const cfg = loadAuthConfig(process.env)
  const fetch = cimdFixtureFromEnv(process.env.E2E_CIMD_DOCUMENTS, cfg.allowEphemeralKey)
  startAuthServer(cfg, undefined, fetch ? { fetch } : {})
}
```

In `packages/schema/test/env-example.test.ts`, add to `EXCLUDED`, after `'E2E_UPSTREAM_HOST'`:

```ts
  'E2E_CIMD_DOCUMENTS',
  'E2E_MCP',
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run apps/auth packages/schema/test/env-example.test.ts && pnpm -w exec tsc -b`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add apps/auth/src/cimd.ts apps/auth/src/server.ts apps/auth/test/cimd-fixture-env.test.ts packages/schema/test/env-example.test.ts
git commit -m "test(auth): load e2e CIMD fixture documents, refused outside development stacks"
```

- [ ] **Step 6: The fixture and the compose override**

Create `apps/e2e/fixtures/mcp-client.json`:

```json
[
  {
    "client_id": "https://mcp-client.e2e.invalid/client.json",
    "client_name": "MetaModels e2e MCP client",
    "redirect_uris": ["http://127.0.0.1:47823/callback"],
    "grant_types": ["authorization_code", "refresh_token"],
    "response_types": ["code"],
    "token_endpoint_auth_method": "none",
    "application_type": "native"
  }
]
```

(RFC 2606 reserves `.invalid`: were the fixture ever bypassed, the OP's fetch could resolve nothing.)

Create `apps/e2e/compose.mcp.yml`:

```yaml
# The e2e MCP override (apps/e2e/README.md, "MCP"). Only ever with an explicit throwaway project:
#   docker compose -p mm-verify --env-file <file> -f docker-compose.yml -f apps/e2e/compose.mcp.yml up -d
# Paths are relative to the project directory, the repository root.
services:
  auth:
    environment:
      # The CIMD fixture is refused without this, and a deployed stack hard-wires it to "false".
      OIDC_ALLOW_EPHEMERAL_KEY: "true"
      E2E_CIMD_DOCUMENTS: /e2e/mcp-client.json
    volumes:
      - ./apps/e2e/fixtures:/e2e:ro
```

- [ ] **Step 7: Share the CLI helpers**

Create `apps/e2e/specs/helpers/admin-cli.ts`. The function bodies are `admin-api.spec.ts`'s current `freshHome`, `credentialsFile`, `credential`, `startCli`, `cli`, `cliJson` and `deviceLogin`, unchanged except that `ISSUER`, `CONSOLE_URL` and `state.homes` come from `stack`:

```ts
import { expect, type Browser } from '@playwright/test'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { watchForViolations } from './console.js'

export interface Cli { code: number | null; stdout: string; stderr: string }
export interface Credential { resource: string; scope: string; accessToken: string; refreshToken?: string }

const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'cli')
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The real `mm` CLI against one named stack. `homes` collects every temporary `XDG_CONFIG_HOME` made,
 * for the caller's cleanup: the operator's own `~/.config/metamodels` is never read or written.
 */
export function adminCli(stack: { consoleUrl: string; issuer: string; homes: string[] }) {
  function freshHome(): string {
    const home = mkdtempSync(path.join(tmpdir(), 'mm-e2e-cli-'))
    stack.homes.push(home)
    return home
  }

  function credentialsFile(home: string): string {
    return path.join(home, 'metamodels', 'credentials.json')
  }

  function credential(home: string): Credential {
    const store = JSON.parse(readFileSync(credentialsFile(home), 'utf8')) as Record<string, Credential>
    const cred = store[stack.issuer]
    if (!cred) throw new Error(`no credential for ${stack.issuer} in ${credentialsFile(home)}`)
    return cred
  }

  /** The CLI exactly as an operator runs it (`pnpm --filter @metamodels/cli start`), minus pnpm. */
  function startCli(home: string, args: string[]) {
    const child = spawn(process.execPath, ['--import', './src/ts-resolve.ts', 'src/index.ts', ...args,
      '--issuer', stack.issuer, ...(args[0] === 'logout' ? [] : ['--console', stack.consoleUrl])], {
      cwd: CLI_DIR,
      env: { ...process.env, XDG_CONFIG_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out = { stdout: '', stderr: '' }
    child.stdout.on('data', (b: Buffer) => { out.stdout += b.toString('utf8') })
    child.stderr.on('data', (b: Buffer) => { out.stderr += b.toString('utf8') })
    const done = new Promise<Cli>((resolve, reject) => {
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, ...out }))
    })
    return { out, done }
  }

  async function cli(home: string, ...args: string[]): Promise<Cli> {
    return startCli(home, args).done
  }

  /** Runs a CLI command that must succeed and print JSON (or nothing). */
  async function cliJson(home: string, ...args: string[]): Promise<unknown> {
    const r = await cli(home, ...args)
    expect(r.code, `mm ${args.join(' ')} failed:\n${r.stderr}`).toBe(0)
    return r.stdout.trim() === '' ? null : JSON.parse(r.stdout)
  }

  /**
   * `mm login`, approved in a fresh browser context the way a person would: open the printed link,
   * check the code, check the requesting machine, Approve, then type the password (every device
   * approval asks for it). No CSP violation or page error is tolerated on any of those pages.
   */
  async function deviceLogin(browser: Browser, scope: string, email: string, password: string): Promise<string> {
    const home = freshHome()
    const run = startCli(home, ['login', '--scope', scope])

    let link = ''
    let userCode = ''
    await expect.poll(() => {
      link = /^\s+(https?:\/\/\S+)\s*$/m.exec(run.out.stderr)?.[1] ?? ''
      userCode = /shows the code\s+(\S+)/.exec(run.out.stderr)?.[1] ?? ''
      return link !== '' && userCode !== ''
    }, { message: 'the CLI never printed a verification link' }).toBe(true)
    expect(new URL(link).origin).toBe(new URL(stack.issuer).origin)

    const context = await browser.newContext()
    const page = await context.newPage()
    const problems = watchForViolations(page)
    try {
      await page.goto(link)
      await expect(page.getByRole('heading', { name: 'Connect the MetaModels CLI' })).toBeVisible()
      await page.getByRole('button', { name: 'Continue' }).click()

      await expect(page.getByRole('heading', { name: 'Approve this sign-in?' })).toBeVisible()
      await expect(page.locator('p.code')).toHaveText(userCode)
      // Where the request came from: the requester's address as the OP saw it, and its user agent,
      // which is the CLI's. The address cannot tell the CLI from this browser: on a compose stack
      // reached through its published ports, both arrive from the Docker bridge address. So this spec
      // only asserts that an address is shown, not whose it is.
      const device = page.locator('p.device')
      await expect(device).toContainText(/IP address: (?!unknown)\S+/)
      await expect(device).toContainText(/User agent: metamodels-cli \(/)
      await page.getByRole('button', { name: 'Approve' }).click()

      await expect(page).toHaveURL(new RegExp(`^${escapeRe(stack.issuer)}/interaction/`))
      await page.getByLabel('Email').fill(email)
      await page.getByLabel('Password').fill(password)
      await page.getByRole('button', { name: 'Sign in' }).click()
      await expect(page.getByRole('heading', { name: 'Signed in' })).toBeVisible()
      expect(problems).toEqual([])
    } finally {
      await context.close()
    }

    const r = await run.done
    expect(r.code, `mm login failed:\n${r.stderr}`).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({ issuer: stack.issuer, console: stack.consoleUrl })
    return home
  }

  return { freshHome, credentialsFile, credential, startCli, cli, cliJson, deviceLogin }
}
```

Append to `apps/e2e/specs/helpers/console.ts` (add `type Browser` to its `@playwright/test` import):

```ts
/** Give a seeded user `role` on the console's Team page, as the operator. A no-op when it has it already. */
export async function ensureRole(browser: Browser, email: string, role: string) {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await login(page)
    await page.goto('/team')
    const select = page.getByRole('row').filter({ hasText: email }).getByRole('combobox')
    if (await select.inputValue() !== role) {
      await select.selectOption(role)
      await expect.poll(async () => {
        await page.reload()
        return page.getByRole('row').filter({ hasText: email }).getByRole('combobox').inputValue()
      }).toBe(role)
    }
  } finally {
    await context.close()
  }
}
```

In `apps/e2e/specs/admin-api.spec.ts`:
- delete the local `Cli` and `Credential` interfaces, `CLI_DIR`, `freshHome`, `credentialsFile`, `credential`, `startCli`, `cli`, `cliJson`, `deviceLogin` and `escapeRe`; drop the imports only they (and the Team-page block below) used: `spawn`, `mkdtempSync`, `readFileSync`, `tmpdir`, `fileURLToPath`, `type Browser`, `login` and `watchForViolations` (`rmSync`, `statSync` and `path` stay);
- import `{ adminCli }` from `./helpers/admin-cli.js` and `{ ensureRole }` from `./helpers/console.js`, and below `state` add:

```ts
const { credentialsFile, credential, cli, cliJson, deviceLogin } = adminCli({ consoleUrl: CONSOLE_URL ?? '', issuer: ISSUER ?? '', homes: state.homes })
```

- in the viewer test, replace the Team-page block (`const context = await browser.newContext()` … `await context.close() }`) with `await ensureRole(browser, VIEWER_EMAIL!, 'viewer')`.

Run: `pnpm -w exec tsc -b && pnpm --filter @metamodels/e2e exec playwright test --list specs/admin-api.spec.ts | tail -1`
Expected: no type errors; the same test count as before the move (`Total: 5 tests in 1 file`).

- [ ] **Step 8: Write the MCP spec**

Create `apps/e2e/specs/mcp.spec.ts`:

```ts
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { expect, test, type Browser } from '@playwright/test'
import { adminCli } from './helpers/admin-cli.js'
import { ensureRole, watchForViolations } from './helpers/console.js'
import { OPERATOR_EMAIL, OPERATOR_PASSWORD, RUN_ID } from './helpers/env.js'

/**
 * M4 end to end (spec §7): a real browser and a real OP take an MCP client through CIMD → consent →
 * token → server/discover → tools/list → tools/call, on an Ollama paddock and on a ComfyUI paddock,
 * then a legacy (2025-11-25) client through initialize → notifications/initialized → tools/list →
 * tools/call on the same paddock and token, against a fake upstream this spec runs; then every negative case of the §7 table that a running
 * stack can show. One `[mcp]` line per case is the record.
 *
 * It creates flocks, paddocks and keys, revokes a key and demotes a user, so it runs only against a
 * stack named explicitly, started with `apps/e2e/compose.mcp.yml` (`E2E_MCP=1` says it was).
 */
const CONSOLE_URL = process.env.E2E_BASE_URL
const ISSUER = process.env.E2E_AUTH_URL
const DATA_PLANE = process.env.E2E_PROXY_URL
const UPSTREAM_HOST = process.env.E2E_UPSTREAM_HOST
const VIEWER_EMAIL = process.env.E2E_VIEWER_EMAIL
const VIEWER_PASSWORD = process.env.E2E_VIEWER_PASSWORD

const REQUIRED = {
  E2E_BASE_URL: CONSOLE_URL, E2E_AUTH_URL: ISSUER, E2E_PROXY_URL: DATA_PLANE, E2E_UPSTREAM_HOST: UPSTREAM_HOST,
  E2E_VIEWER_EMAIL: VIEWER_EMAIL, E2E_VIEWER_PASSWORD: VIEWER_PASSWORD, E2E_MCP: process.env.E2E_MCP,
}
const missing = Object.entries(REQUIRED).filter(([, v]) => !v).map(([k]) => k)
const refusal = missing.length ? `mcp.spec.ts needs a throwaway stack started with compose.mcp.yml: set ${missing.join(', ')}` : null
if (refusal !== null && /^(true|1)$/i.test(process.env.CI ?? '')) throw new Error(`${refusal} (CI is true, so this is an error, not a skip)`)
test.skip(refusal !== null, refusal ?? '')
test.describe.configure({ mode: 'serial' })

const CLIENT = (JSON.parse(readFileSync(new URL('../fixtures/mcp-client.json', import.meta.url), 'utf8')) as Array<{ client_id: string; redirect_uris: string[] }>)[0]!
const REDIRECT = CLIENT.redirect_uris[0]!
const VERSION = '2026-07-28'
const OLLAMA_SLUG = `e2e-mcp-o-${RUN_ID}`
const COMFY_SLUG = `e2e-mcp-c-${RUN_ID}`
const API = `${CONSOLE_URL}/api/admin/v1`
const resourceOf = (slug: string) => `${DATA_PLANE}/p/${slug}/mcp`

const state = {
  homes: [] as string[],
  operator: '',
  flockIds: [] as string[],
  paddock: {} as Record<string, string>,
  tokens: {} as Record<string, { access: string; refresh?: string }>,
}
const { credential, deviceLogin } = adminCli({ consoleUrl: CONSOLE_URL ?? '', issuer: ISSUER ?? '', homes: state.homes })
const record = (what: string, outcome: string | number) => console.log(`[mcp] ${what} -> ${outcome}`)

// --- A fake upstream that is both an Ollama and a ComfyUI --------------------------------------
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const upstreamSeen: string[] = []
let upstream: Server
let upstreamBase = ''

function fakeUpstream(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://fake')
  upstreamSeen.push(`${req.method} ${url.pathname}`)
  const json = (body: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
  if (url.pathname === '/api/version') return json({ version: 'fake' })
  if (url.pathname === '/api/tags') return json({ models: [{ name: 'fake-model' }] })
  if (url.pathname === '/api/chat') {
    return json({ model: 'fake-model', message: { role: 'assistant', content: 'Hello from the fake upstream' }, done: true, prompt_eval_count: 3, eval_count: 4 })
  }
  if (url.pathname === '/system_stats') return json({})
  if (url.pathname === '/prompt') return json({ prompt_id: `job-${RUN_ID}` })
  if (url.pathname.startsWith('/history/')) {
    const id = decodeURIComponent(url.pathname.slice('/history/'.length))
    return json({
      [id]: {
        status: { completed: true, messages: [['execution_start', { timestamp: 1000 }], ['execution_success', { timestamp: 1250 }]] },
        outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } },
      },
    })
  }
  if (url.pathname === '/view') return res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.length) }).end(PNG)
  res.writeHead(404).end()
}

// --- Admin API, as the operator ---------------------------------------------------------------
async function api(method: string, route: string, body?: unknown, token = credential(state.operator).accessToken) {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  expect(res.status, `${method} ${route}: ${text}`).toBeLessThan(300)
  return text ? JSON.parse(text) as Record<string, any> : null
}

async function makePaddock(breed: 'ollama' | 'comfyui', slug: string, constraintJson: unknown) {
  const flock = await api('POST', '/flocks', { name: `e2e-mcp-${breed}-${RUN_ID}`, breed, baseUrl: upstreamBase, tlsTrust: false })
  state.flockIds.push(flock!.id)
  const paddock = await api('POST', '/paddocks', { flockId: flock!.id, name: `MCP ${breed} ${RUN_ID}`, slug })
  await api('PUT', `/paddocks/${paddock!.id}/fence`, { constraintJson, rateLimit: { windowSec: 60, max: 100 } })
  state.paddock[slug] = paddock!.id
}

// --- The MCP client ---------------------------------------------------------------------------
async function discover(slug: string) {
  const res = await fetch(resourceOf(slug), { method: 'POST', headers: { 'content-type': 'application/json', 'mcp-protocol-version': VERSION }, body: '{}' })
  const challenge = res.headers.get('www-authenticate') ?? ''
  record(`no token on ${slug}`, `${res.status} ${challenge}`)
  expect(res.status).toBe(401)
  const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1]
  expect(metadataUrl).toBe(`${DATA_PLANE}/.well-known/oauth-protected-resource/p/${slug}/mcp`)
  const metadata = await (await fetch(metadataUrl!)).json() as { resource: string; authorization_servers: string[] }
  expect(metadata).toMatchObject({ resource: resourceOf(slug), authorization_servers: [ISSUER] })
  return await (await fetch(`${metadata.authorization_servers[0]}/.well-known/openid-configuration`)).json() as {
    authorization_endpoint: string; token_endpoint: string
  }
}

/** Authorize in a real browser; returns the redirect the OP sent back (never loaded: it is caught). */
async function authorizeInBrowser(browser: Browser, authorizationEndpoint: string, slug: string, who: { email: string; password: string }, decide: 'approve' | 'refused') {
  const verifier = randomBytes(32).toString('base64url')
  const url = new URL(authorizationEndpoint)
  url.search = new URLSearchParams({
    // As real MCP clients ask: no offline_access, no prompt=consent (ruling R4).
    client_id: CLIENT.client_id, response_type: 'code', redirect_uri: REDIRECT, scope: 'openid mcp',
    resource: resourceOf(slug), state: RUN_ID,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
  }).toString()

  const context = await browser.newContext()
  const page = await context.newPage()
  const problems = watchForViolations(page)
  let back: URL | null = null
  await page.route(`${new URL(REDIRECT).origin}/**`, (route) => {
    back = new URL(route.request().url())
    return route.fulfill({ status: 200, contentType: 'text/plain', body: 'done' })
  })
  try {
    await page.goto(url.href)
    await page.getByLabel('Email').fill(who.email)
    await page.getByLabel('Password').fill(who.password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    if (decide === 'approve') {
      await expect(page.getByRole('heading', { name: 'Connect an app to MetaModels?' })).toBeVisible()
      await expect(page.locator('strong', { hasText: new URL(CLIENT.client_id).host }).first()).toBeVisible()
      await expect(page.getByText(who.email)).toBeVisible()
      await page.getByRole('button', { name: 'Approve' }).click()
    } else {
      await expect(page.getByRole('heading', { name: 'You cannot approve this app' })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0)
      await page.getByRole('button', { name: 'Close' }).click()
    }
    await expect.poll(() => back !== null, { message: 'the OP never redirected back to the client' }).toBe(true)
    // D5: the widened form-action let every form post reach the client's loopback redirect.
    expect(problems).toEqual([])
  } finally {
    await context.close()
  }
  return { back: back!, verifier }
}

async function token(tokenEndpoint: string, fields: Record<string, string>) {
  const res = await fetch(tokenEndpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT.client_id, ...fields }).toString(),
  })
  return { status: res.status, json: await res.json() as Record<string, any> }
}

const LEGACY_VERSION = '2025-11-25'
const CLIENT_INFO = { name: 'metamodels-e2e', version: '0.0.0' }
type RpcBody = { result?: any; error?: { code: number } } | null

async function post(slug: string, headers: Record<string, string>, body: unknown, bearer: string | null) {
  const res = await fetch(resourceOf(slug), {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...headers, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, sessionId: res.headers.get('mcp-session-id'), body: (text ? JSON.parse(text) : null) as RpcBody }
}

let rpcId = 1
/** A modern (2026-07-28) request: `_meta` in the body, and the headers the transport mirrors from it. */
async function mcp(slug: string, method: string, params: Record<string, unknown>, bearer: string | null) {
  return post(slug, {
    'mcp-protocol-version': VERSION,
    'mcp-method': method,
    ...(method === 'tools/call' && typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
  }, {
    jsonrpc: '2.0', id: rpcId++, method,
    params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': VERSION, 'io.modelcontextprotocol/clientInfo': CLIENT_INFO, 'io.modelcontextprotocol/clientCapabilities': {} } },
  }, bearer)
}

/** A legacy (2025-11-25) message: no `_meta`; `MCP-Protocol-Version` on everything after `initialize`. */
async function legacyMcp(slug: string, message: { method: string; params?: Record<string, unknown>; notification?: boolean }, bearer: string) {
  const headers = message.method === 'initialize' ? {} : { 'mcp-protocol-version': LEGACY_VERSION }
  const body = { jsonrpc: '2.0', ...(message.notification ? {} : { id: rpcId++ }), method: message.method, ...(message.params ? { params: message.params } : {}) }
  return post(slug, headers, body, bearer)
}

async function connect(browser: Browser, slug: string) {
  const as = await discover(slug)
  const { back, verifier } = await authorizeInBrowser(browser, as.authorization_endpoint, slug, { email: OPERATOR_EMAIL, password: OPERATOR_PASSWORD }, 'approve')
  const code = back.searchParams.get('code')
  expect(code, back.href).toBeTruthy()
  const t = await token(as.token_endpoint, { grant_type: 'authorization_code', code: code!, redirect_uri: REDIRECT, code_verifier: verifier, resource: resourceOf(slug) })
  expect(t.status, JSON.stringify(t.json)).toBe(200)
  // Ruling R4: a refresh token although the request asked for neither offline_access nor prompt=consent.
  expect(typeof t.json.refresh_token, 'an MCP client gets a refresh token').toBe('string')
  state.tokens[slug] = { access: t.json.access_token, refresh: t.json.refresh_token }
  record(`consent + token for ${slug}`, `${t.status} refresh_token=${typeof t.json.refresh_token === 'string'}`)
}

// --- Lifecycle --------------------------------------------------------------------------------
test.beforeAll(async ({ browser }) => {
  upstream = createServer(fakeUpstream)
  await new Promise<void>((resolve) => upstream.listen(0, '0.0.0.0', resolve))
  upstreamBase = `http://${UPSTREAM_HOST}:${(upstream.address() as AddressInfo).port}`
  state.operator = await deviceLogin(browser, 'read,resource.write', OPERATOR_EMAIL, OPERATOR_PASSWORD)
  await makePaddock('ollama', OLLAMA_SLUG, { allowedRoutes: ['chat', 'read'], allowedModels: ['fake-model'] })
  await makePaddock('comfyui', COMFY_SLUG, {
    templates: [{
      id: 'txt2img',
      graph: { '6': { class_type: 'CLIPTextEncode', inputs: { text: 'x' } }, '9': { class_type: 'SaveImage', inputs: {} } },
      params: [{ name: 'prompt', type: 'text', target: { node: '6', input: 'text' } }],
      cost: 1,
    }],
  })
})

test.afterAll(async () => {
  upstream?.close()
  try {
    // Deleting a flock cascades to its paddocks, and so to their key scopes. Keys are revoked, never deleted.
    for (const id of state.flockIds) await fetch(`${API}/flocks/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${credential(state.operator).accessToken}` } })
  } catch {
    // Best effort: a cleanup failure must not hide the test failure that left the fixture.
  }
  for (const home of state.homes) rmSync(home, { recursive: true, force: true })
})

// --- The real flow ------------------------------------------------------------------------------
test('Ollama: CIMD discovery, consent, token, then discover, list and a metered chat', async ({ browser }) => {
  await connect(browser, OLLAMA_SLUG)
  const at = state.tokens[OLLAMA_SLUG]!.access

  const discovered = await mcp(OLLAMA_SLUG, 'server/discover', {}, at)
  expect(discovered.body?.result).toMatchObject({
    resultType: 'complete',
    supportedVersions: expect.arrayContaining([VERSION, LEGACY_VERSION]),
    capabilities: { tools: {} },
    _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'metamodels' } },
    cacheScope: 'private',
  })
  record('modern server/discover', discovered.status)
  const listed = await mcp(OLLAMA_SLUG, 'tools/list', {}, at)
  const names = (listed.body?.result?.tools as Array<{ name: string }>).map((t) => t.name)
  expect(names).toEqual(['chat', 'list_models'])
  record('tools/list (mutate never listed)', names.join(','))

  const chat = await mcp(OLLAMA_SLUG, 'tools/call', { name: 'chat', arguments: { model: 'fake-model', messages: [{ role: 'user', content: 'hi' }] } }, at)
  expect(chat.body?.result?.content).toEqual([{ type: 'text', text: 'Hello from the fake upstream' }])
  expect(upstreamSeen).toContain('POST /api/chat')

  // The metered usage_rollup row, under the oauth key (the worker aggregates asynchronously).
  const keys = await api('GET', '/keys?limit=200') as unknown as Array<{ id: string; kind: string; paddockSlugs: string[] }>
  const oauthKey = keys.find((k) => k.kind === 'oauth' && k.paddockSlugs.includes(OLLAMA_SLUG))
  expect(oauthKey, 'the consent minted an oauth key').toBeTruthy()
  const hour = (d: Date) => d.toISOString().slice(0, 13)
  const range = new URLSearchParams({ startBucket: hour(new Date(Date.now() - 3600_000)), endBucket: hour(new Date(Date.now() + 3600_000)), paddockId: state.paddock[OLLAMA_SLUG]! })
  await expect.poll(async () => {
    const rows = await api('GET', `/usage/matrix?${range}`) as unknown as Array<{ keyId: string; dim: string; total: number }>
    return rows.filter((r) => r.keyId === oauthKey!.id).map((r) => `${r.dim}=${r.total}`).sort().join(' ')
  }, { timeout: 60_000, message: 'no usage_rollup row under the oauth key' }).toBe('tokens_in=3 tokens_out=4')
  record('usage_rollup under the oauth key', 'tokens_in=3 tokens_out=4')
})

test('legacy 2025-11-25 on the same paddock and token: initialize, initialized, tools/list, tools/call', async () => {
  const at = state.tokens[OLLAMA_SLUG]!.access
  const init = await legacyMcp(OLLAMA_SLUG, { method: 'initialize', params: { protocolVersion: LEGACY_VERSION, capabilities: {}, clientInfo: CLIENT_INFO } }, at)
  expect(init.body?.result).toMatchObject({
    protocolVersion: LEGACY_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'metamodels', title: `MCP ollama ${RUN_ID}` },
  })
  expect(init.sessionId, 'stateless: no session is minted').toBeNull()
  const initialized = await legacyMcp(OLLAMA_SLUG, { method: 'notifications/initialized', notification: true }, at)
  expect(initialized.status).toBe(202)
  const listed = await legacyMcp(OLLAMA_SLUG, { method: 'tools/list' }, at)
  expect((listed.body?.result?.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(['chat', 'list_models'])
  expect(listed.body?.result).not.toHaveProperty('resultType')
  const chat = await legacyMcp(OLLAMA_SLUG, { method: 'tools/call', params: { name: 'chat', arguments: { model: 'fake-model', messages: [{ role: 'user', content: 'hi' }] } } }, at)
  expect(chat.body?.result?.content).toEqual([{ type: 'text', text: 'Hello from the fake upstream' }])
  record('legacy initialize → initialized → tools/list → tools/call', `${init.status} ${initialized.status} ${listed.status} ${chat.status}`)
})

test('ComfyUI: run a template, then get_job_result returns the image as base64', async ({ browser }) => {
  await connect(browser, COMFY_SLUG)
  const at = state.tokens[COMFY_SLUG]!.access
  const run = await mcp(COMFY_SLUG, 'tools/call', { name: 'run_txt2img', arguments: { prompt: 'a cat' } }, at)
  expect(run.body?.result?.structuredContent).toEqual({ job_id: `job-${RUN_ID}` })
  const result = await mcp(COMFY_SLUG, 'tools/call', { name: 'get_job_result', arguments: { job_id: `job-${RUN_ID}` } }, at)
  expect(result.body?.result?.content).toEqual([
    { type: 'text', text: 'Job finished with 1 image.' },
    { type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' },
  ])
  record('ComfyUI run + get_job_result', 'image/png')
})

// --- The §7 negative cases ----------------------------------------------------------------------
test('refused credentials: another paddock\'s token, an admin-API token, an mm_live_ key, an oauth token on the proxy', async () => {
  const ollamaAt = state.tokens[OLLAMA_SLUG]!.access
  const cases: Array<[string, string, string]> = [
    ['token for another paddock', COMFY_SLUG, ollamaAt],
    ['admin-API token', OLLAMA_SLUG, credential(state.operator).accessToken],
  ]
  const live = await api('POST', '/keys', { name: `e2e-mcp-live-${RUN_ID}`, paddockIds: [state.paddock[OLLAMA_SLUG]] })
  cases.push(['mm_live_ key on /mcp', OLLAMA_SLUG, live!.plaintext as string])
  for (const [what, slug, bearer] of cases) {
    const r = await mcp(slug, 'tools/list', {}, bearer)
    record(what, r.status)
    expect(r.status).toBe(401)
  }
  const proxy = await fetch(`${DATA_PLANE}/p/${OLLAMA_SLUG}/api/chat`, {
    method: 'POST', headers: { authorization: `Bearer ${ollamaAt}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fake-model', messages: [{ role: 'user', content: 'hi' }] }),
  })
  record('oauth token on the proxy', proxy.status)
  expect(proxy.status).toBe(401)
  await api('POST', `/keys/${live!.id}/revoke`)
})

test('the fence still decides: a disallowed model is isError; a mutate route cannot be called', async () => {
  const at = state.tokens[OLLAMA_SLUG]!.access
  const denied = await mcp(OLLAMA_SLUG, 'tools/call', { name: 'chat', arguments: { model: 'other-model', messages: [{ role: 'user', content: 'hi' }] } }, at)
  record('disallowed model via tools/call', JSON.stringify(denied.body?.result))
  expect(denied.body?.result).toEqual({ content: [{ type: 'text', text: 'model not allowed: other-model' }], isError: true })
  const pull = await mcp(OLLAMA_SLUG, 'tools/call', { name: 'pull', arguments: { name: 'x' } }, at)
  record('tools/call pull', pull.body?.error?.code ?? 'none')
  expect(pull.body?.error?.code).toBe(-32602)
})

test('a viewer sees the refusal and only Close, and the client gets access_denied', async ({ browser }) => {
  await ensureRole(browser, VIEWER_EMAIL!, 'viewer')
  const as = await discover(OLLAMA_SLUG)
  const { back } = await authorizeInBrowser(browser, as.authorization_endpoint, OLLAMA_SLUG, { email: VIEWER_EMAIL!, password: VIEWER_PASSWORD! }, 'refused')
  record('viewer consent', back.searchParams.get('error') ?? 'none')
  expect(back.searchParams.get('error')).toBe('access_denied')
})

test('a loopback or RFC 1918 client_id is never fetched', async () => {
  const as = await discover(OLLAMA_SLUG)
  for (const clientId of ['https://127.0.0.1/client.json', 'https://localhost/client.json', 'https://10.0.0.1/client.json', 'https://172.16.0.1/client.json']) {
    const url = new URL(as.authorization_endpoint)
    url.search = new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: REDIRECT, scope: 'openid mcp', resource: resourceOf(OLLAMA_SLUG), code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' }).toString()
    const res = await fetch(url, { redirect: 'manual' })
    record(`CIMD client_id ${clientId}`, res.status)
    expect(res.status).toBe(400)
  }
})

test('a revoked key: 401 at the data plane at once, and invalid_grant on refresh', async () => {
  const as = await discover(OLLAMA_SLUG)
  const keys = await api('GET', '/keys?limit=200') as unknown as Array<{ id: string; kind: string; status: string; paddockSlugs: string[] }>
  const oauthKey = keys.find((k) => k.kind === 'oauth' && k.status === 'active' && k.paddockSlugs.includes(OLLAMA_SLUG))!
  await api('POST', `/keys/${oauthKey.id}/revoke`)
  await expect.poll(async () => (await mcp(OLLAMA_SLUG, 'tools/list', {}, state.tokens[OLLAMA_SLUG]!.access)).status).toBe(401)
  record('revoked key at the data plane', 401)
  const refreshed = await token(as.token_endpoint, { grant_type: 'refresh_token', refresh_token: state.tokens[OLLAMA_SLUG]!.refresh!, resource: resourceOf(OLLAMA_SLUG) })
  record('revoked key, refresh', `${refreshed.status} ${refreshed.json.error}`)
  expect(refreshed.json.error).toBe('invalid_grant')
})
```

- [ ] **Step 9: Typecheck and list**

Run: `pnpm -w exec tsc -b && pnpm --filter @metamodels/e2e exec playwright test --list specs/mcp.spec.ts | tail -1`
Expected: no type errors; `Total: 8 tests in 1 file`.

- [ ] **Step 10: Bring up the throwaway stack**

Never the `metamodels` project, never its ports (3200/8787/3100). Check the ports are free, then start `mm-verify`:

```bash
ss -ltnp | grep -E ':(3310|3311|8797)\b' && echo "PORT IN USE — pick others" || echo free
SCRATCH=$(mktemp -d)
cp .env.example "$SCRATCH/mm-verify.env"
cat >> "$SCRATCH/mm-verify.env" <<'EOF'
CONTROL_PLANE_PORT=3310
AUTH_HOST_PORT=3311
DATA_PLANE_PORT=8797
CONSOLE_URL=http://localhost:3310
OIDC_ISSUER=http://localhost:3311
DATA_PLANE_URL=http://localhost:8797
EOF
docker compose -p mm-verify --env-file "$SCRATCH/mm-verify.env" -f docker-compose.yml -f apps/e2e/compose.mcp.yml up -d --build --wait
docker compose -p mm-verify --env-file "$SCRATCH/mm-verify.env" -f docker-compose.yml run --rm control-plane pnpm seed
OPERATOR_EMAIL=viewer@example.test OPERATOR_PASSWORD=viewer-password-0123 \
  docker compose -p mm-verify --env-file "$SCRATCH/mm-verify.env" -f docker-compose.yml run --rm -e OPERATOR_EMAIL -e OPERATOR_PASSWORD control-plane pnpm seed
docker compose -p mm-verify --env-file "$SCRATCH/mm-verify.env" logs auth | grep -E 'E2E_CIMD_DOCUMENTS|listening'
```

Expected: `free`; every service `Healthy`/`Started`; the auth log shows `serving 1 fixture client document(s)` and `listening on :3100 (issuer http://localhost:3311)`.

- [ ] **Step 11: Run the spec, then the existing suites, on that stack**

```bash
GW=$(docker network inspect mm-verify_default -f '{{(index .IPAM.Config 0).Gateway}}')
export E2E_BASE_URL=http://localhost:3310 E2E_AUTH_URL=http://localhost:3311 E2E_PROXY_URL=http://localhost:8797 \
  E2E_UPSTREAM_HOST="$GW" E2E_VIEWER_EMAIL=viewer@example.test E2E_VIEWER_PASSWORD=viewer-password-0123 E2E_MCP=1
pnpm --filter @metamodels/e2e exec playwright test specs/mcp.spec.ts 2>&1 | tee "$SCRATCH/mcp-e2e.log"
grep '^\[mcp\]' "$SCRATCH/mcp-e2e.log"
pnpm --filter @metamodels/e2e exec playwright test 2>&1 | tail -5
```

Expected: `8 passed`; the `[mcp]` lines show `consent + token for … -> 200 refresh_token=true` (twice), `modern server/discover -> 200`, `legacy initialize → initialized → tools/list → tools/call -> 200 202 200 200`, `no token … 401 Bearer resource_metadata="…"`, `token for another paddock -> 401`, `admin-API token -> 401`, `mm_live_ key on /mcp -> 401`, `oauth token on the proxy -> 401`, `disallowed model … isError`, `tools/call pull -> -32602`, `viewer consent -> access_denied`, four `CIMD client_id … -> 400`, `revoked key at the data plane -> 401`, `revoked key, refresh -> 400 invalid_grant`, and `usage_rollup under the oauth key -> tokens_in=3 tokens_out=4`. The full run passes every spec that is not skipped for a missing opt-in (the acceptance walkthrough skips without `OLLAMA_TEST_URL`: the existing proxy suites are unchanged).

- [ ] **Step 12: The two negative cases proven by unit suites**

Run:

```bash
pnpm --filter @metamodels/control-plane exec vitest run --testTimeout=30000 src/server/internal-oauth-keys.test.ts -t 'replay'
pnpm exec vitest run packages/connectors/test/ollama-mcp-call.test.ts packages/connectors/test/comfyui-mcp-call.test.ts -t 'mutate|own upstream routes'
```

Expected: the replayed-assertion test passes (`401` on the second use of one `jti`); both "never plans a mutate route" tests pass.

- [ ] **Step 13: Tear down the throwaway stack**

```bash
docker compose -p mm-verify --env-file "$SCRATCH/mm-verify.env" -f docker-compose.yml -f apps/e2e/compose.mcp.yml down -v
docker ps -a --filter label=com.docker.compose.project=mm-verify --format '{{.Names}}' | wc -l
rm -rf "$SCRATCH"
```

Expected: `0` — nothing left of `mm-verify`; project `metamodels` untouched (`docker compose -p metamodels ps` unchanged from before Step 10).

- [ ] **Step 14: Document it**

In `apps/e2e/README.md`, add after the admin-API section:

```markdown
### MCP (`specs/mcp.spec.ts`)

The M4 flow with a real browser and a real OP: RFC 9728 discovery from the endpoint's `401`, the
OP's consent screen for a Client ID Metadata Document client, the token exchange, then
`server/discover`, `tools/list` and `tools/call` on an Ollama paddock and a ComfyUI paddock (run, then
`get_job_result`), then the legacy `2025-11-25` sequence (`initialize`, `notifications/initialized`,
`tools/list`, `tools/call`) on the same paddock and token. The spec runs its own fake upstream (both breeds on one port), creates its
flocks and paddocks through the admin API, and prints one `[mcp]` line per negative case of the M4
spec's §7 table. The replayed consent assertion and "mutate is never planned" are unit-level; see
the commands in the plan's Task 15, Step 12.

The OP must serve the client's metadata document from a fixture, never from the network, so the
stack is started with the override:

    docker compose -p mm-verify --env-file <file> -f docker-compose.yml -f apps/e2e/compose.mcp.yml up -d

It sets `E2E_CIMD_DOCUMENTS` on the auth service, which refuses it unless `OIDC_ALLOW_EPHEMERAL_KEY`
is `true`: no deployed stack can load it. Set `E2E_MCP=1` to say the stack was started this way, plus
the admin spec's four variables, `E2E_PROXY_URL`, and `E2E_UPSTREAM_HOST` (this machine as the
data-plane container reaches it, e.g. the compose network's gateway). It revokes keys and demotes the
viewer, so point it at a throwaway stack only.
```

and add rows to the variables table:

```markdown
| `E2E_MCP` | *(unset — mcp spec skips)* | `1` when the stack was started with `apps/e2e/compose.mcp.yml` |
| `E2E_CIMD_DOCUMENTS` | *(set by `compose.mcp.yml`, inside the auth container)* | The fixture CIMD documents; refused unless `OIDC_ALLOW_EPHEMERAL_KEY=true` |
```

In `docs/superpowers/specs/2026-09-06-remote-control-surface-design.md:339`, append to the M4 row's last cell: ` — designed in [2026-09-29-m4-mcp-endpoint-design.md](2026-09-29-m4-mcp-endpoint-design.md), which settles C5 against §2.4 as full OAuth (its §2)`.

- [ ] **Step 15: Final sweep**

Run:

```bash
pnpm test
pnpm --filter @metamodels/control-plane exec vitest run --testTimeout=30000
pnpm --filter @metamodels/control-plane build && pnpm -w exec tsc -b
git diff origin/main -- . ':!docs/superpowers' | grep -E '^\+.*192\.168\.' | grep -v "'192.168.255.254'" || echo "no LAN IP"
git grep -n 'metamodels\.cc' -- 'apps/*/src' 'packages/*/src' || echo "no metamodels.cc in runtime code"
git log --format='%an <%ae>%n%b' origin/main..HEAD | grep -ciE 'co-authored|generated with' || true
```

Expected: both lanes PASS; typecheck clean; `no LAN IP` (the one `192.168.` literal added is Task 5's RFC 1918 test address, `192.168.255.254`, which names no host); `no metamodels.cc in runtime code`; `0` attribution lines, and every author `Carmelo Santana <me@carmelosantana.com>`.

- [ ] **Step 16: Commit**

```bash
git add apps/e2e docs/superpowers/specs/2026-09-06-remote-control-surface-design.md
git commit -m "test(e2e): drive the MCP flow and the M4 negative cases on a throwaway stack"
```

---

## Rulings folded into the spec (2026-09-29)

These amend the spec and are already applied in the tasks above.

- **R1 — 2026-07-28 conformance (Task 12).** `Origin`; the `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers matched against the body with `-32020` (the Base64 sentinel decoded first); `-32022` with `{ supported, requested }`; HTTP 404 + `-32601` for an unknown method; 202 for notifications; `Mcp-Session-Id` and `Last-Event-ID` ignored; 405 for GET and DELETE. Modern results carry `resultType`, `_meta` serverInfo, and on discover and list the schema-required `ttlMs` plus `cacheScope: 'private'`.
- **R2 / D9 — dual-era (Task 12).** Legacy `2025-11-25` / `2025-06-18` served statelessly: `initialize`, `notifications/initialized`, `ping`, `tools/list` and `tools/call`, with legacy result shapes. The era dispatch, and the treatment of a legacy request without the header, are stated in Task 12 with the rules they rest on.
- **R3 — `serverInfo.version` is `'0.0.0'` (Task 12).** No version source exists in the stack; no build plumbing.
- **R4 — refresh tokens without `offline_access` (Tasks 6, 8, 9, 15).** CIMD client, refresh grant allowed, and bound to an MCP resource: issued, and not session-bound. Every other client keeps the defaults.
- **R5 — replay guard (Tasks 4, 14).** The memory fallback stays; `DEPLOY.md` says it is per-process without `REDIS_URL`.
- **R6 — the plan follows the code.** keys-service has no lock or publish, so the internal route calls `publishConfigInvalidation` itself (Task 4), as `(app)/keys/actions.ts` and `admin-route.ts` do. Also: `list_models` (Task 10); `/view` bytes under 8 MiB (Task 12); oauth keys found by grant plus paddock (Task 6); the four bare-`Bearer` assertions updated (Task 13).
- **R7 — both eras end to end (Task 15)** against the same paddock and token.
