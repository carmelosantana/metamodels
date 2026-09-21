# M1 — Auth foundation: OpenID Provider + console as relying party

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. **Every subagent is Opus — implementer, fixer, task reviewer and whole-branch reviewer. Never Haiku, never Sonnet. Pass `model: "opus"` explicitly on every dispatch.** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a separate `auth` service (oidc-provider) that issues every non-consumer credential, and cut the operator console over to it as a relying party so password login leaves the console.

**Architecture:** A new workspace app `apps/auth` runs oidc-provider on its own Koa listener, storing OIDC state in a Postgres `oidc_payload` table and authenticating users against the existing `user` table. The console becomes a confidential OIDC client: `/login` redirects to the OP, `/auth/callback` exchanges the code, verifies the ID token with `jose`, and mints the console's existing local session. The OP also issues RFC 9068 JWT access tokens for the admin-API resource — the token contract M2 and M4 build on.

**Tech Stack:** TypeScript (ESM), pnpm workspace, oidc-provider 9 (Koa), jose 6, drizzle-orm + Postgres (pglite in tests), Next.js 16 App Router, vitest, Playwright.

**Spec:** [`docs/superpowers/specs/2026-09-06-remote-control-surface-design.md`](../specs/2026-09-06-remote-control-surface-design.md) — read §2.3, §3, §4.1, §4.2, §4.6 and §7 before starting. Where this plan and the spec disagree, the spec's §7 amendments win.

## Global Constraints

- **New runtime dependencies are exactly two:** `oidc-provider@~9.12.2` (in `apps/auth`) and `jose@^6.2.12` (in `apps/control-plane`). Pin oidc-provider with `~` — its experimental features break in minor versions. Anything else needs a plan change, not a judgment call.
- **Before any `pnpm add`, run `/powerup:supply-chain`** and read the resulting `pnpm-lock.yaml` diff. The repo `.npmrc` already enforces `minimumReleaseAge=1440` and `blockExoticSubdeps=true`; do not weaken either.
- **No hardcoded hosts.** Every public URL (`OIDC_ISSUER`, `CONSOLE_URL`) comes from configuration. Never write a LAN IP or `metamodels.cc` into shipped code.
- **Never run compose in a project that could be the live stack.** The operator's real stack runs from `~/Projects/metamodels` under the default project name. Every `docker compose` command in this plan passes an explicit `-p` project name and non-default host ports.
- **`mutate` routes stay unexposable.** Nothing in M1 touches the data plane or breeds.
- **Password code moves, it is not rewritten.** `verifyPassword`, `hashPassword`, `DUMMY_PASSWORD_HASH` and `LoginThrottle` keep their exact behaviour, including the timing-oracle mitigation.
- **Commits** are authored `Carmelo Santana <me@carmelosantana.com>`, conventional-commit style, with no attribution trailers. `main` is protected — work on a branch, land by PR.
- **Test lanes that must stay green after every task:** root `pnpm test`, and the control-plane lane `pnpm --filter @metamodels/control-plane exec vitest run`. Type-checking the control plane means `pnpm --filter @metamodels/control-plane build` (Next type-checks during build; `tsc -b` needs its `.next/types`).
- **Out of scope for M1** (spec §7): CIMD, a consent screen, the device grant, the admin API itself, the MCP endpoint, and any change to `mm_live_` keys.

## File map

| File | Responsibility |
|---|---|
| `packages/schema/src/capabilities.ts` | The capability names — also the OAuth scope values of the admin-API resource |
| `packages/schema/src/password.ts` | scrypt hash/verify (moved from the console, unchanged) |
| `packages/schema/src/schema.ts` | + `oidcPayload` table |
| `apps/auth/src/config.ts` | Parse and validate the auth service's configuration |
| `apps/auth/src/keys.ts` | Turn the configured RSA key into a signing JWKS |
| `apps/auth/src/db.ts` | The `Db` type the auth service accepts |
| `apps/auth/src/adapter.ts` | oidc-provider storage adapter over `oidc_payload`, plus expiry sweep |
| `apps/auth/src/account.ts` | `verifyLogin` (moved) and `findAccount` |
| `apps/auth/src/login-throttle.ts` | Per-IP login throttle (moved, unchanged) |
| `apps/auth/src/views.ts` | Server-rendered HTML pages, stylesheet, CSP |
| `apps/auth/src/interactions.ts` | Koa middleware: login form, auto-consent, health, assets, headers |
| `apps/auth/src/resources.ts` | Resource servers the OP issues access tokens for |
| `apps/auth/src/provider.ts` | Assembles the oidc-provider instance |
| `apps/auth/src/server.ts` | Process entrypoint |
| `apps/control-plane/src/auth/session.ts` | + generic `sealJson`/`openJson`; session codec unchanged on the wire |
| `apps/control-plane/src/auth/oidc-client.ts` | Relying-party client: discovery, authorize URL, code exchange, ID-token verification |
| `apps/control-plane/src/server/sign-in.ts` | Pure callback validation → `Actor` or a failure reason |
| `apps/control-plane/src/server/oidc-session.ts` | Transaction cookie + the process-wide `OidcClient` |
| `apps/control-plane/src/server/license-on-login.ts` | Best-effort licence revalidation, moved out of the old login action |
| `apps/control-plane/src/app/login/route.ts` | Replaces the login page: redirect to the OP |
| `apps/control-plane/src/app/auth/callback/route.ts` | OIDC redirect target |
| `apps/control-plane/src/app/auth/error/page.tsx` | Human-readable sign-in failure |

**Deleted by the end of M1:** `apps/control-plane/src/app/login/page.tsx`, `apps/control-plane/src/server/auth-service.ts` (+ test), `apps/control-plane/src/auth/login-throttle.ts` (+ test).

**Kept, deliberately:** `apps/control-plane/src/auth/session.ts` — an OIDC relying party always keeps a local session; it cannot read the OP's cookie from another origin (spec §4.2 as amended).

---

### Task 1: Shared auth primitives in `@metamodels/schema`

Moves password hashing into the shared package (the auth service needs it; the console's seed and invite flows still hash passwords) and makes the capability list a shared constant, because the admin-API resource's OAuth scopes must be exactly the capability names (spec §2.2).

**Files:**
- Create: `packages/schema/src/capabilities.ts`
- Create: `packages/schema/test/capabilities.test.ts`
- Create: `packages/schema/src/oidc.ts`
- Create: `packages/schema/test/oidc.test.ts`
- Move: `apps/control-plane/src/auth/password.ts` → `packages/schema/src/password.ts`
- Move: `apps/control-plane/src/auth/password.test.ts` → `packages/schema/test/password.test.ts`
- Modify: `packages/schema/src/index.ts`
- Modify: `apps/control-plane/src/auth/authorize.ts:4`
- Modify: `apps/control-plane/src/server/seed.ts:5`, `apps/control-plane/src/server/invites-service.ts:7`, `apps/control-plane/src/server/auth-service.ts:5`, `apps/control-plane/src/server/auth-service.test.ts:7`

**Interfaces:**
- Produces: `CAPABILITIES: readonly ['read', 'resource.write', 'user.manage', 'license.manage']`, `type Capability`, `hashPassword(plaintext: string): Promise<string>`, `verifyPassword(plaintext: string, stored: string): Promise<boolean>`, `CONSOLE_CLIENT_ID = 'metamodels-console'`, `adminApiResource(consoleUrl: string): string` — all exported from `@metamodels/schema`. The auth service (issuer) and the console (client, and from M2 the admin API's resource server) both import the last two, so they cannot drift apart.

- [ ] **Step 1: Write the failing capabilities test**

Create `packages/schema/test/capabilities.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { CAPABILITIES } from '../src/capabilities.js'

// RFC 6749 §3.3: scope-token = 1*( %x21 / %x23-5B / %x5D-7E )
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/

describe('CAPABILITIES', () => {
  test('lists exactly the console capabilities, in a stable order', () => {
    expect(CAPABILITIES).toEqual(['read', 'resource.write', 'user.manage', 'license.manage'])
  })

  test('every capability is a valid, unique OAuth scope token', () => {
    for (const c of CAPABILITIES) expect(c).toMatch(SCOPE_TOKEN)
    expect(new Set(CAPABILITIES).size).toBe(CAPABILITIES.length)
  })
})
```

Create `packages/schema/test/oidc.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { adminApiResource, CONSOLE_CLIENT_ID } from '../src/oidc.js'

describe('shared OIDC identifiers', () => {
  test('the console client id is stable (every console ID token names it as aud)', () => {
    expect(CONSOLE_CLIENT_ID).toBe('metamodels-console')
  })

  test('the admin API resource is the console origin plus /api/admin', () => {
    expect(adminApiResource('https://console.example.test')).toBe('https://console.example.test/api/admin')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run packages/schema/test/capabilities.test.ts packages/schema/test/oidc.test.ts`
Expected: FAIL — `Failed to load url ../src/capabilities.js` and `../src/oidc.js` (neither module exists).

- [ ] **Step 3: Create the module and export it**

Create `packages/schema/src/capabilities.ts`:

```ts
/**
 * The operator console's capability names.
 *
 * These are ALSO the OAuth scope values the admin-API resource server accepts, so a token's
 * granted scopes map one-to-one onto `requireCapability()` checks (spec §2.2). Renaming one is
 * a breaking change to every issued token.
 */
export const CAPABILITIES = ['read', 'resource.write', 'user.manage', 'license.manage'] as const

export type Capability = (typeof CAPABILITIES)[number]
```

Create `packages/schema/src/oidc.ts`:

```ts
/**
 * Identifiers the auth service (the issuer) and the console (a client, and from M2 the admin
 * API's resource server) must agree on byte for byte. One definition, imported by both.
 */

/** The console's OAuth client_id — the `aud` of every console ID token. */
export const CONSOLE_CLIENT_ID = 'metamodels-console'

/** The admin API's RFC 8707 resource indicator — and therefore the `aud` of its access tokens. */
export function adminApiResource(consoleUrl: string): string {
  return `${consoleUrl}/api/admin`
}
```

In `packages/schema/src/index.ts`, add after `export * from './keys.js'`:

```ts
export * from './capabilities.js'
export * from './oidc.js'
export * from './password.js'
```

(`./password.js` resolves after Step 5; the barrel is only imported by tests and apps, so no test loads it before then.)

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run packages/schema/test/capabilities.test.ts packages/schema/test/oidc.test.ts`
Expected: PASS, 4 tests (2 capabilities, 2 oidc).

- [ ] **Step 5: Move the password module and its test**

```bash
git mv apps/control-plane/src/auth/password.ts packages/schema/src/password.ts
git mv apps/control-plane/src/auth/password.test.ts packages/schema/test/password.test.ts
```

In `packages/schema/test/password.test.ts`, change line 2 from `import { hashPassword, verifyPassword } from './password'` to:

```ts
import { hashPassword, verifyPassword } from '../src/password.js'
```

`packages/schema/src/password.ts` needs no content change — it only imports `node:crypto` and `node:util`.

- [ ] **Step 6: Repoint the console's imports**

Replace each import line exactly:

| File | Old | New |
|---|---|---|
| `apps/control-plane/src/server/seed.ts` | `import { hashPassword } from '../auth/password'` | `import { hashPassword } from '@metamodels/schema'` |
| `apps/control-plane/src/server/invites-service.ts` | `import { hashPassword } from '../auth/password'` | `import { hashPassword } from '@metamodels/schema'` |
| `apps/control-plane/src/server/auth-service.ts` | `import { verifyPassword } from '../auth/password'` | `import { verifyPassword } from '@metamodels/schema'` |
| `apps/control-plane/src/server/auth-service.test.ts` | `import { verifyPassword } from '../auth/password'` | `import { verifyPassword } from '@metamodels/schema'` |

If a file already imports from `@metamodels/schema`, merge the name into that existing import instead of adding a second line.

In `apps/control-plane/src/auth/authorize.ts`, replace

```ts
export type Capability = 'read' | 'resource.write' | 'user.manage' | 'license.manage'
```

with

```ts
import type { Capability } from '@metamodels/schema'
export type { Capability }
```

and move that `import type` line up beside the existing `import { USER_ROLES, type UserRole } from '@metamodels/schema'` (merge them: `import { USER_ROLES, type UserRole, type Capability } from '@metamodels/schema'`, then keep `export type { Capability }` below the imports). Every existing `import { type Capability } from '../auth/authorize'` keeps working.

- [ ] **Step 7: Run every affected test**

Run: `pnpm exec vitest run packages/schema/test/password.test.ts packages/schema/test/capabilities.test.ts packages/schema/test/oidc.test.ts`
Expected: PASS, 7 tests.

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/auth-service.test.ts src/server/invites-service.test.ts src/server/seed.test.ts src/auth/authorize.test.ts`
Expected: PASS, all tests (no count change versus before the task).

Run: `grep -rn "auth/password" apps/control-plane/src apps/control-plane/bin || echo "no stale imports"`
Expected: `no stale imports`.

- [ ] **Step 8: Type-check and commit**

Run: `pnpm exec tsc -b packages/schema && pnpm --filter @metamodels/control-plane build`
Expected: both exit 0.

```bash
git add packages/schema apps/control-plane/src
git commit -m "refactor(schema): share password hashing and the capability list"
```

---

### Task 2: `oidc_payload` table and migration

oidc-provider persists sessions, interactions, grants, codes and tokens through an adapter. They live in Postgres beside everything else (spec §4.1 as amended), in one table keyed by `(model, id)` — the model name namespaces ids, so an `AccessToken` and a `Session` may share an id.

**Files:**
- Modify: `packages/schema/src/schema.ts` (line 1 import; append table at end of file)
- Create: `packages/schema/drizzle/0006_<generated>.sql` and the updated `packages/schema/drizzle/meta/*` (generated by drizzle-kit — do not hand-write)
- Create: `packages/schema/test/oidc-payload.test.ts`

**Interfaces:**
- Produces: `oidcPayload` table exported from `@metamodels/schema` with columns `model: text`, `id: text`, `payload: jsonb`, `grantId: text | null`, `userCode: text | null`, `uid: text | null`, `expiresAt: Date | null`, `consumedAt: Date | null`; primary key `(model, id)`.

- [ ] **Step 1: Write the failing test**

Create `packages/schema/test/oidc-payload.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { and, eq } from 'drizzle-orm'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as schema from '../src/schema.js'

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../drizzle')

async function freshDb() {
  const db = drizzle(new PGlite(), { schema })
  await migrate(db, { migrationsFolder })
  return db
}

describe('oidc_payload', () => {
  test('stores a payload keyed by (model, id) with nullable lookup and lifecycle columns', async () => {
    const db = await freshDb()
    await db.insert(schema.oidcPayload).values({ model: 'Session', id: 'abc', payload: { kind: 'Session' }, uid: 'u-1' })
    const rows = await db
      .select()
      .from(schema.oidcPayload)
      .where(and(eq(schema.oidcPayload.model, 'Session'), eq(schema.oidcPayload.id, 'abc')))
    expect(rows).toHaveLength(1)
    expect(rows[0].payload).toEqual({ kind: 'Session' })
    expect(rows[0].uid).toBe('u-1')
    expect(rows[0].grantId).toBeNull()
    expect(rows[0].expiresAt).toBeNull()
    expect(rows[0].consumedAt).toBeNull()
  })

  test('the same id may exist under two different models', async () => {
    const db = await freshDb()
    await db.insert(schema.oidcPayload).values({ model: 'Session', id: 'same', payload: {} })
    await db.insert(schema.oidcPayload).values({ model: 'AccessToken', id: 'same', payload: {} })
    expect(await db.select().from(schema.oidcPayload)).toHaveLength(2)
  })

  test('a duplicate (model, id) is rejected by the primary key', async () => {
    const db = await freshDb()
    await db.insert(schema.oidcPayload).values({ model: 'Grant', id: 'g1', payload: {} })
    await expect(db.insert(schema.oidcPayload).values({ model: 'Grant', id: 'g1', payload: {} })).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run packages/schema/test/oidc-payload.test.ts`
Expected: FAIL — `schema.oidcPayload` is undefined, so the insert throws.

- [ ] **Step 3: Add the table**

In `packages/schema/src/schema.ts`, extend the line-1 import with `index` and `primaryKey`:

```ts
import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
```

Append at the end of the file:

```ts
/**
 * oidc-provider's persisted state (sessions, interactions, grants, codes, tokens), written only
 * by the auth service's adapter. `model` namespaces `id`. `expires_at` null = never expires;
 * rows past it are invisible to lookups and removed by the auth service's periodic sweep.
 */
export const oidcPayload = pgTable('oidc_payload', {
  model: text('model').notNull(),
  id: text('id').notNull(),
  payload: jsonb('payload').notNull(),
  grantId: text('grant_id'),
  userCode: text('user_code'),
  uid: text('uid'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
}, (t) => [
  primaryKey({ columns: [t.model, t.id] }),
  index('oidc_payload_grant_id').on(t.grantId),
  index('oidc_payload_uid').on(t.uid),
  index('oidc_payload_user_code').on(t.userCode),
  index('oidc_payload_expires_at').on(t.expiresAt),
])
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm --filter @metamodels/schema db:generate`
Expected: drizzle-kit reports one new migration, `packages/schema/drizzle/0006_<random_name>.sql`.

Run: `cat packages/schema/drizzle/0006_*.sql`
Expected: exactly one `CREATE TABLE "oidc_payload"` with a composite `PRIMARY KEY("model","id")` and four `CREATE INDEX` statements — and nothing touching any other table. If it alters another table, stop: the snapshot has drifted, and that is a separate problem to report, not to paper over.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run packages/schema/test/oidc-payload.test.ts`
Expected: PASS, 3 tests.

Run: `pnpm exec vitest run packages/schema apps/migrate`
Expected: PASS — the existing schema and migrate suites still apply every migration cleanly.

- [ ] **Step 6: Commit**

```bash
git add packages/schema/src/schema.ts packages/schema/drizzle packages/schema/test/oidc-payload.test.ts
git commit -m "feat(schema): add oidc_payload table for the auth service"
```

---

### Task 3: Scaffold `apps/auth` — configuration and signing keys

**Files:**
- Create: `apps/auth/package.json`, `apps/auth/tsconfig.json`
- Create: `apps/auth/src/config.ts`, `apps/auth/src/keys.ts`, `apps/auth/src/db.ts`
- Create: `apps/auth/test/helpers/keys.ts`, `apps/auth/test/config.test.ts`, `apps/auth/test/keys.test.ts`
- Modify: `tsconfig.json` (root references)

**Interfaces:**
- Produces:
  - `interface AuthConfig { issuer: string; consoleUrl: string; consoleClientSecret: string; cookieKeys: string[]; signingKeyPem: string | null; allowEphemeralKey: boolean; databaseUrl: string; port: number }`
  - `loadAuthConfig(env: Record<string, string | undefined>): AuthConfig` — throws a message naming the offending variable.
  - `signingJwks(pem: string | null, allowEphemeral: boolean): { keys: JWK[] }`
  - `rsaThumbprint(jwk: { e: string; n: string }): string`
  - `type Db = PgDatabase<any, any, any>` from `apps/auth/src/db.ts`
  - Test helper `rsaPemBase64(bits?: number): string` in `apps/auth/test/helpers/keys.ts`

**Environment contract** (documented in `.env.example` by Task 9):

| Variable | Required | Meaning |
|---|---|---|
| `OIDC_ISSUER` | yes | Public issuer URL. Origin only — no path, query or fragment. |
| `CONSOLE_URL` | yes | Public console URL. Origin only. Redirect and post-logout URIs derive from it. |
| `CONSOLE_CLIENT_SECRET` | yes | Shared with the console. ≥16 chars. |
| `OIDC_COOKIE_KEYS` | yes | Comma-separated cookie-signing keys, newest first. Each ≥16 chars. |
| `OIDC_SIGNING_KEY` | yes in production | Base64 of an RSA ≥2048-bit PKCS#8 PEM. |
| `OIDC_ALLOW_EPHEMERAL_KEY` | no | `true` mints a throwaway key when `OIDC_SIGNING_KEY` is empty. Local development only. |
| `DATABASE_URL` | yes | Postgres. |
| `AUTH_PORT` | no | Listen port inside the container. Default `3100`. |

- [ ] **Step 1: Create the package skeleton**

Create `apps/auth/package.json`:

```json
{
  "name": "@metamodels/auth",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "src/server.ts",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "start": "tsx src/server.ts"
  }
}
```

Create `apps/auth/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "composite": true },
  "references": [{ "path": "../../packages/schema" }],
  "include": ["src"]
}
```

In the root `tsconfig.json`, add `{ "path": "apps/auth" }` to `references`, directly after `{ "path": "apps/data-plane" }`.

- [ ] **Step 2: Vet, then add the dependencies**

Run `/powerup:supply-chain` for `oidc-provider@~9.12.2`, `jose@^6.2.12`, `@types/oidc-provider@~9.12.1` and `@types/koa`. The spec (§2.3) records the vetting of the first three as of 2026-09-15; re-check publish dates — if a version newer than those resolves and is under 48h old, stop and report.

```bash
pnpm --filter @metamodels/auth add "@metamodels/schema@workspace:*" drizzle-orm@^0.45.2 postgres@^3.4.0 oidc-provider@~9.12.2
pnpm --filter @metamodels/auth add -D @types/oidc-provider@~9.12.1 @types/koa jose@^6.2.12 @electric-sql/pglite@^0.5.4 tsx@^4.19.0
```

Run: `git diff pnpm-lock.yaml | grep -E '^\+  [@a-z][^ ]*@[0-9][^ ]*:$' | sort`
Expected: the only new packages are `oidc-provider`, `jose`, `koa` and koa's dependency tree (`accepts`, `content-disposition`, `cookies`, `http-errors`, `keygrip`, `koa-compose`, `mime-types`, `statuses`, `type-is`, … — 39 packages total with oidc-provider, per deps.dev), and `@types/*` packages (`@types/oidc-provider`, `@types/koa`, `@types/keygrip` and their `@types` dependencies). Anything else — stop and report it.

`@types/koa` is already in the tree transitively; declaring it directly lets `apps/auth` import Koa's `Middleware` type under pnpm's strict resolution.

- [ ] **Step 3: Write the failing tests**

Create `apps/auth/test/helpers/keys.ts`:

```ts
import { generateKeyPairSync } from 'node:crypto'

const cache = new Map<number, string>()

/** Base64 of a PKCS#8 PEM RSA private key — the exact shape OIDC_SIGNING_KEY carries. Cached per size. */
export function rsaPemBase64(bits = 2048): string {
  let v = cache.get(bits)
  if (!v) {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: bits })
    v = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }) as string).toString('base64')
    cache.set(bits, v)
  }
  return v
}
```

Create `apps/auth/test/config.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { loadAuthConfig } from '../src/config.js'
import { rsaPemBase64 } from './helpers/keys.js'

function env(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    OIDC_ISSUER: 'https://auth.example.test/',
    CONSOLE_URL: 'https://console.example.test',
    CONSOLE_CLIENT_SECRET: 'console-secret-0123456789',
    OIDC_COOKIE_KEYS: 'cookie-key-new-0123456789, cookie-key-old-0123456789',
    OIDC_SIGNING_KEY: rsaPemBase64(),
    DATABASE_URL: 'postgres://u:p@db:5432/mm',
    ...over,
  }
}

describe('loadAuthConfig', () => {
  test('parses a complete environment', () => {
    const cfg = loadAuthConfig(env())
    expect(cfg.issuer).toBe('https://auth.example.test') // trailing slash stripped
    expect(cfg.consoleUrl).toBe('https://console.example.test')
    expect(cfg.cookieKeys).toEqual(['cookie-key-new-0123456789', 'cookie-key-old-0123456789'])
    expect(cfg.signingKeyPem).toContain('-----BEGIN PRIVATE KEY-----')
    expect(cfg.allowEphemeralKey).toBe(false)
    expect(cfg.port).toBe(3100)
  })

  test.each(['OIDC_ISSUER', 'CONSOLE_URL', 'CONSOLE_CLIENT_SECRET', 'OIDC_COOKIE_KEYS', 'DATABASE_URL'])(
    'names %s when it is missing',
    (name) => {
      expect(() => loadAuthConfig(env({ [name]: undefined }))).toThrow(`${name} is required`)
    },
  )

  test('rejects a non-URL, a path, or a query on the public URLs', () => {
    expect(() => loadAuthConfig(env({ OIDC_ISSUER: 'auth.example.test' }))).toThrow('OIDC_ISSUER must be an absolute http(s) URL')
    expect(() => loadAuthConfig(env({ OIDC_ISSUER: 'https://auth.example.test/oidc' }))).toThrow('OIDC_ISSUER must be an origin')
    expect(() => loadAuthConfig(env({ CONSOLE_URL: 'https://c.example.test/?x=1' }))).toThrow('CONSOLE_URL must be an origin')
  })

  test('enforces secret length on the client secret and every cookie key', () => {
    expect(() => loadAuthConfig(env({ CONSOLE_CLIENT_SECRET: 'short' }))).toThrow('CONSOLE_CLIENT_SECRET must be at least 16 characters')
    expect(() => loadAuthConfig(env({ OIDC_COOKIE_KEYS: 'cookie-key-new-0123456789,short' }))).toThrow('OIDC_COOKIE_KEYS must be at least 16 characters')
  })

  test('refuses to start without a signing key unless ephemeral keys are explicitly allowed', () => {
    expect(() => loadAuthConfig(env({ OIDC_SIGNING_KEY: '' }))).toThrow('OIDC_SIGNING_KEY is required')
    const dev = loadAuthConfig(env({ OIDC_SIGNING_KEY: '', OIDC_ALLOW_EPHEMERAL_KEY: 'true' }))
    expect(dev.signingKeyPem).toBeNull()
    expect(dev.allowEphemeralKey).toBe(true)
  })

  test('rejects a signing key that is not base64 of a PKCS#8 PEM', () => {
    expect(() => loadAuthConfig(env({ OIDC_SIGNING_KEY: Buffer.from('nope').toString('base64') }))).toThrow('PKCS#8')
  })

  test('validates AUTH_PORT', () => {
    expect(loadAuthConfig(env({ AUTH_PORT: '4100' })).port).toBe(4100)
    expect(() => loadAuthConfig(env({ AUTH_PORT: 'eighty' }))).toThrow('AUTH_PORT must be a TCP port number')
  })
})
```

Create `apps/auth/test/keys.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { rsaThumbprint, signingJwks } from '../src/keys.js'
import { rsaPemBase64 } from './helpers/keys.js'

const pem = (b64: string) => Buffer.from(b64, 'base64').toString('utf8')

describe('signingJwks', () => {
  test('turns a configured RSA PEM into one RS256 signing key with an RFC 7638 kid', () => {
    const { keys } = signingJwks(pem(rsaPemBase64()), false)
    expect(keys).toHaveLength(1)
    const k = keys[0] as { kty: string; alg: string; use: string; kid: string; n: string; e: string; d?: string }
    expect(k).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig' })
    expect(k.d).toBeTruthy() // the OP needs the private part
    const expected = createHash('sha256').update(JSON.stringify({ e: k.e, kty: 'RSA', n: k.n })).digest('base64url')
    expect(k.kid).toBe(expected)
    expect(rsaThumbprint(k)).toBe(expected)
  })

  test('the kid is stable for one key and differs between keys', () => {
    const a1 = signingJwks(pem(rsaPemBase64()), false).keys[0].kid
    const a2 = signingJwks(pem(rsaPemBase64()), false).keys[0].kid
    const b = signingJwks(null, true).keys[0].kid
    expect(a1).toBe(a2)
    expect(b).not.toBe(a1)
  })

  test('refuses to mint a key unless ephemeral keys are allowed', () => {
    expect(() => signingJwks(null, false)).toThrow('OIDC_SIGNING_KEY is required')
  })

  test('rejects non-RSA and undersized keys', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
    expect(() => signingJwks(ec, false)).toThrow('must be an RSA private key')
    expect(() => signingJwks(pem(rsaPemBase64(1024)), false)).toThrow('at least 2048 bits')
  })
})
```

- [ ] **Step 4: Run them to verify they fail**

Run: `pnpm exec vitest run apps/auth/test/config.test.ts apps/auth/test/keys.test.ts`
Expected: FAIL — `../src/config.js` and `../src/keys.js` cannot be resolved.

- [ ] **Step 5: Implement**

Create `apps/auth/src/db.ts`:

```ts
import type { PgDatabase } from 'drizzle-orm/pg-core'

/** Any Drizzle Postgres database — postgres-js in production, pglite in tests. */
export type Db = PgDatabase<any, any, any>
```

Create `apps/auth/src/config.ts`:

```ts
export interface AuthConfig {
  /** Public issuer URL (origin only, no trailing slash). Browsers, clients and token `iss` all see this. */
  issuer: string
  /** Public console URL (origin only, no trailing slash). */
  consoleUrl: string
  consoleClientSecret: string
  /** Cookie-signing keys, newest first. */
  cookieKeys: string[]
  /** PKCS#8 PEM of the RSA signing key, or null when unset (only legal with allowEphemeralKey). */
  signingKeyPem: string | null
  allowEphemeralKey: boolean
  databaseUrl: string
  port: number
}

type Env = Record<string, string | undefined>

const MIN_SECRET_LENGTH = 16

function required(env: Env, name: string): string {
  const v = env[name]?.trim()
  if (!v) throw new Error(`${name} is required`)
  return v
}

/** An absolute http(s) URL that is a bare origin; returned without a trailing slash. */
function origin(name: string, value: string): string {
  let u: URL
  try {
    u = new URL(value)
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`${name} must be an absolute http(s) URL`)
  if (u.pathname !== '/' || u.search || u.hash) throw new Error(`${name} must be an origin (no path, query or fragment)`)
  return u.origin
}

function secret(name: string, value: string): string {
  if (value.length < MIN_SECRET_LENGTH) throw new Error(`${name} must be at least ${MIN_SECRET_LENGTH} characters`)
  return value
}

export function loadAuthConfig(env: Env): AuthConfig {
  const cookieKeys = required(env, 'OIDC_COOKIE_KEYS').split(',').map((k) => k.trim()).filter(Boolean)
  for (const k of cookieKeys) secret('OIDC_COOKIE_KEYS', k)

  const allowEphemeralKey = env.OIDC_ALLOW_EPHEMERAL_KEY === 'true'
  const rawKey = env.OIDC_SIGNING_KEY?.trim()
  let signingKeyPem: string | null = null
  if (rawKey) {
    signingKeyPem = Buffer.from(rawKey, 'base64').toString('utf8')
    if (!signingKeyPem.includes('-----BEGIN PRIVATE KEY-----')) {
      throw new Error('OIDC_SIGNING_KEY must be base64 of a PKCS#8 PEM (-----BEGIN PRIVATE KEY-----)')
    }
  } else if (!allowEphemeralKey) {
    throw new Error('OIDC_SIGNING_KEY is required (OIDC_ALLOW_EPHEMERAL_KEY=true is for local development only)')
  }

  const port = env.AUTH_PORT ? Number(env.AUTH_PORT) : 3100
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('AUTH_PORT must be a TCP port number')

  return {
    issuer: origin('OIDC_ISSUER', required(env, 'OIDC_ISSUER')),
    consoleUrl: origin('CONSOLE_URL', required(env, 'CONSOLE_URL')),
    consoleClientSecret: secret('CONSOLE_CLIENT_SECRET', required(env, 'CONSOLE_CLIENT_SECRET')),
    cookieKeys,
    signingKeyPem,
    allowEphemeralKey,
    databaseUrl: required(env, 'DATABASE_URL'),
    port,
  }
}
```

Note `origin()` returns `u.origin`, which never has a trailing slash — that is how `https://auth.example.test/` normalises.

Create `apps/auth/src/keys.ts`:

```ts
import { createHash, createPrivateKey, generateKeyPairSync, type KeyObject } from 'node:crypto'
import type { JWK } from 'oidc-provider'

const MIN_MODULUS_BITS = 2048

/** RFC 7638 thumbprint of an RSA JWK: SHA-256 over the required members in lexicographic order. */
export function rsaThumbprint(jwk: { e: string; n: string }): string {
  return createHash('sha256').update(`{"e":"${jwk.e}","kty":"RSA","n":"${jwk.n}"}`).digest('base64url')
}

/**
 * The OP's signing key set. A configured PEM wins. With none, a throwaway key is minted only when
 * explicitly allowed — every token it signs dies with the process, which is exactly why
 * production refuses it.
 */
export function signingJwks(pem: string | null, allowEphemeral: boolean): { keys: JWK[] } {
  let key: KeyObject
  if (pem) key = createPrivateKey(pem)
  else if (allowEphemeral) key = generateKeyPairSync('rsa', { modulusLength: MIN_MODULUS_BITS }).privateKey
  else throw new Error('OIDC_SIGNING_KEY is required (OIDC_ALLOW_EPHEMERAL_KEY=true is for local development only)')

  if (key.asymmetricKeyType !== 'rsa') throw new Error('OIDC_SIGNING_KEY must be an RSA private key')
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0
  if (bits < MIN_MODULUS_BITS) throw new Error(`OIDC_SIGNING_KEY must be at least ${MIN_MODULUS_BITS} bits (got ${bits})`)

  const jwk = key.export({ format: 'jwk' }) as { kty: string; n: string; e: string }
  return { keys: [{ ...jwk, kid: rsaThumbprint(jwk), alg: 'RS256', use: 'sig' } as JWK] }
}
```

RS256 is deliberate: it is the OIDC default every client supports, so no client metadata needs an algorithm override.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm exec vitest run apps/auth/test/config.test.ts apps/auth/test/keys.test.ts`
Expected: PASS, 15 tests (11 config incl. 5 parametrised, 4 keys).

- [ ] **Step 7: Type-check and commit**

Run: `pnpm exec tsc -b apps/auth`
Expected: exit 0.

```bash
git add apps/auth tsconfig.json pnpm-lock.yaml
git commit -m "feat(auth): scaffold the auth service with config and signing keys"
```

---

### Task 4: Postgres storage adapter

Implements oidc-provider's `Adapter` interface over `oidc_payload`. Time comes from an injectable clock so expiry is testable; every lookup ignores expired rows, and `sweepExpired` physically removes them.

**Files:**
- Create: `apps/auth/src/adapter.ts`
- Create: `apps/auth/test/helpers/db.ts`
- Create: `apps/auth/test/adapter.test.ts`

**Interfaces:**
- Consumes: `oidcPayload` (Task 2), `Db` (Task 3).
- Produces:
  - `class PgAdapter implements Adapter` — `constructor(db: Db, model: string, now?: () => Date)`
  - `pgAdapterFactory(db: Db, now?: () => Date): (name: string) => Adapter`
  - `sweepExpired(db: Db, now?: Date): Promise<number>`
  - Test helpers: `makeDb(): Promise<TestDb>`, `seedUser(db, { email, password, status?, role? }): Promise<string>` (returns the user id), `type TestDb`

- [ ] **Step 1: Create the test database helper**

Create `apps/auth/test/helpers/db.ts`:

```ts
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as schema from '@metamodels/schema'
import { hashPassword } from '@metamodels/schema'

export type TestDb = ReturnType<typeof drizzle<typeof schema>>

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../packages/schema/drizzle')

export async function makeDb(): Promise<TestDb> {
  const db = drizzle(new PGlite(), { schema })
  await migrate(db, { migrationsFolder })
  return db
}

/** Insert an org and a user with a real scrypt hash. Returns the user id (the OIDC `sub`). */
export async function seedUser(
  db: TestDb,
  opts: { email: string; password: string; status?: string; role?: string },
): Promise<string> {
  const [org] = await db.insert(schema.org).values({ name: `org-${opts.email}` }).returning()
  const [u] = await db.insert(schema.user).values({
    orgId: org.id,
    email: opts.email,
    passwordHash: await hashPassword(opts.password),
    role: opts.role ?? 'admin',
    status: opts.status ?? 'active',
  }).returning()
  return u.id
}
```

- [ ] **Step 2: Write the failing tests**

Create `apps/auth/test/adapter.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { PgAdapter, pgAdapterFactory, sweepExpired } from '../src/adapter.js'
import { makeDb } from './helpers/db.js'

function clock(start = Date.UTC(2026, 0, 1)) {
  let t = start
  return { now: () => new Date(t), advance: (seconds: number) => { t += seconds * 1000 } }
}

describe('PgAdapter', () => {
  test('find returns exactly what upsert stored', async () => {
    const db = await makeDb()
    const a = new PgAdapter(db, 'Session')
    await a.upsert('s1', { kind: 'Session', uid: 'u1', accountId: 'acct-1' }, 60)
    expect(await a.find('s1')).toEqual({ kind: 'Session', uid: 'u1', accountId: 'acct-1' })
  })

  test('models are isolated: the same id under another model is not found', async () => {
    const db = await makeDb()
    await new PgAdapter(db, 'Session').upsert('x', { kind: 'Session' }, 60)
    expect(await new PgAdapter(db, 'AccessToken').find('x')).toBeUndefined()
  })

  test('upsert overwrites the payload for an existing id', async () => {
    const db = await makeDb()
    const a = new PgAdapter(db, 'Session')
    await a.upsert('s1', { kind: 'Session', accountId: 'old' }, 60)
    await a.upsert('s1', { kind: 'Session', accountId: 'new' }, 60)
    expect(await a.find('s1')).toEqual({ kind: 'Session', accountId: 'new' })
  })

  test('a row past its expiry is invisible', async () => {
    const db = await makeDb()
    const c = clock()
    const a = pgAdapterFactory(db, c.now)('AccessToken')
    await a.upsert('t1', { kind: 'AccessToken' }, 10)
    c.advance(9)
    expect(await a.find('t1')).toBeDefined()
    c.advance(2)
    expect(await a.find('t1')).toBeUndefined()
  })

  test('without expiresIn a row never expires', async () => {
    const db = await makeDb()
    const c = clock()
    const a = new PgAdapter(db, 'Grant', c.now)
    await a.upsert('g1', { kind: 'Grant' })
    c.advance(10 * 365 * 24 * 3600)
    expect(await a.find('g1')).toEqual({ kind: 'Grant' })
  })

  test('consume marks the row consumed without removing it', async () => {
    const db = await makeDb()
    const a = new PgAdapter(db, 'AuthorizationCode')
    await a.upsert('c1', { kind: 'AuthorizationCode' }, 60)
    await a.consume('c1')
    const found = await a.find('c1')
    expect(found).toMatchObject({ kind: 'AuthorizationCode' })
    expect(found && found.consumed).toBeTruthy()
  })

  test('destroy removes the row', async () => {
    const db = await makeDb()
    const a = new PgAdapter(db, 'Session')
    await a.upsert('s1', { kind: 'Session' }, 60)
    await a.destroy('s1')
    expect(await a.find('s1')).toBeUndefined()
  })

  test('findByUid and findByUserCode use their lookup columns', async () => {
    const db = await makeDb()
    const sessions = new PgAdapter(db, 'Session')
    const devices = new PgAdapter(db, 'DeviceCode')
    await sessions.upsert('s1', { kind: 'Session', uid: 'uid-1' }, 60)
    await devices.upsert('d1', { kind: 'DeviceCode', userCode: 'ABCD-EFGH' }, 60)
    expect(await sessions.findByUid('uid-1')).toMatchObject({ uid: 'uid-1' })
    expect(await devices.findByUserCode('ABCD-EFGH')).toMatchObject({ userCode: 'ABCD-EFGH' })
    expect(await sessions.findByUid('nope')).toBeUndefined()
  })

  test('revokeByGrantId removes this model\'s rows for that grant and nothing else', async () => {
    const db = await makeDb()
    const at = new PgAdapter(db, 'AccessToken')
    const rt = new PgAdapter(db, 'RefreshToken')
    await at.upsert('a1', { kind: 'AccessToken', grantId: 'g1' }, 60)
    await at.upsert('a2', { kind: 'AccessToken', grantId: 'g1' }, 60)
    await at.upsert('a3', { kind: 'AccessToken', grantId: 'g2' }, 60)
    await rt.upsert('r1', { kind: 'RefreshToken', grantId: 'g1' }, 60)
    await at.revokeByGrantId('g1')
    expect(await at.find('a1')).toBeUndefined()
    expect(await at.find('a2')).toBeUndefined()
    expect(await at.find('a3')).toBeDefined()
    expect(await rt.find('r1')).toBeDefined()
  })
})

describe('sweepExpired', () => {
  test('deletes only expired rows and reports how many', async () => {
    const db = await makeDb()
    const c = clock()
    const factory = pgAdapterFactory(db, c.now)
    await factory('AccessToken').upsert('old', { kind: 'AccessToken' }, 5)
    await factory('AccessToken').upsert('fresh', { kind: 'AccessToken' }, 3600)
    await factory('Grant').upsert('forever', { kind: 'Grant' })
    c.advance(10)
    expect(await sweepExpired(db, c.now())).toBe(1)
    expect(await factory('AccessToken').find('fresh')).toBeDefined()
    expect(await factory('Grant').find('forever')).toBeDefined()
  })
})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm exec vitest run apps/auth/test/adapter.test.ts`
Expected: FAIL — `../src/adapter.js` cannot be resolved.

- [ ] **Step 4: Implement the adapter**

Create `apps/auth/src/adapter.ts`:

```ts
import { and, eq, gt, isNull, lt, or, type SQL } from 'drizzle-orm'
import { oidcPayload } from '@metamodels/schema'
import type { Adapter, AdapterPayload } from 'oidc-provider'
import type { Db } from './db.js'

/**
 * oidc-provider storage over the `oidc_payload` table. One instance per model name (Session,
 * AccessToken, …); the model namespaces ids. Expired rows are invisible to every lookup and are
 * physically removed by `sweepExpired`.
 */
export class PgAdapter implements Adapter {
  constructor(
    private readonly db: Db,
    private readonly model: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void> {
    const expiresAt = expiresIn ? new Date(this.now().getTime() + expiresIn * 1000) : null
    const columns = {
      payload: payload as unknown,
      grantId: payload.grantId ?? null,
      userCode: payload.userCode ?? null,
      uid: payload.uid ?? null,
      expiresAt,
    }
    // consumed_at is deliberately left out of the update: re-saving a model never un-consumes it.
    await this.db
      .insert(oidcPayload)
      .values({ model: this.model, id, ...columns })
      .onConflictDoUpdate({ target: [oidcPayload.model, oidcPayload.id], set: columns })
  }

  find(id: string): Promise<AdapterPayload | undefined> {
    return this.findWhere(eq(oidcPayload.id, id))
  }

  findByUid(uid: string): Promise<AdapterPayload | undefined> {
    return this.findWhere(eq(oidcPayload.uid, uid))
  }

  findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
    return this.findWhere(eq(oidcPayload.userCode, userCode))
  }

  async consume(id: string): Promise<void> {
    await this.db.update(oidcPayload).set({ consumedAt: this.now() }).where(this.mine(eq(oidcPayload.id, id)))
  }

  async destroy(id: string): Promise<void> {
    await this.db.delete(oidcPayload).where(this.mine(eq(oidcPayload.id, id)))
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    await this.db.delete(oidcPayload).where(this.mine(eq(oidcPayload.grantId, grantId)))
  }

  private mine(cond: SQL): SQL | undefined {
    return and(eq(oidcPayload.model, this.model), cond)
  }

  private async findWhere(cond: SQL): Promise<AdapterPayload | undefined> {
    const rows = await this.db
      .select()
      .from(oidcPayload)
      .where(and(this.mine(cond), or(isNull(oidcPayload.expiresAt), gt(oidcPayload.expiresAt, this.now()))))
      .limit(1)
    const row = rows[0]
    if (!row) return undefined
    const payload = row.payload as AdapterPayload
    return row.consumedAt ? { ...payload, consumed: Math.floor(row.consumedAt.getTime() / 1000) } : payload
  }
}

export function pgAdapterFactory(db: Db, now: () => Date = () => new Date()): (name: string) => Adapter {
  return (name) => new PgAdapter(db, name, now)
}

/** Physically delete every expired row. Returns the number removed. */
export async function sweepExpired(db: Db, now: Date = new Date()): Promise<number> {
  const removed = await db.delete(oidcPayload).where(lt(oidcPayload.expiresAt, now)).returning({ id: oidcPayload.id })
  return removed.length
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run apps/auth/test/adapter.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Type-check and commit**

Run: `pnpm exec tsc -b apps/auth`
Expected: exit 0.

```bash
git add apps/auth/src/adapter.ts apps/auth/test/helpers/db.ts apps/auth/test/adapter.test.ts
git commit -m "feat(auth): Postgres storage adapter for oidc-provider"
```

---

### Task 5: Accounts, login verification and the throttle

`verifyLogin`, `DUMMY_PASSWORD_HASH` and `LoginThrottle` are **copied** from the console here, unchanged in behaviour. The console keeps its own copies until Task 11 deletes them — the console's password login must keep working until the cutover commit.

The only behavioural difference: `verifyLogin` returns the user id (`accountId`, the OIDC `sub`) instead of a console `Actor`, because the OP knows nothing about console capabilities.

**Files:**
- Create: `apps/auth/src/account.ts`
- Create: `apps/auth/src/login-throttle.ts`
- Create: `apps/auth/test/account.test.ts`
- Create: `apps/auth/test/login-throttle.test.ts`

**Interfaces:**
- Consumes: `verifyPassword`, `USER_ROLES`, `user` from `@metamodels/schema`; `Db`; test helpers `makeDb`, `seedUser`.
- Produces:
  - `DUMMY_PASSWORD_HASH: string`
  - `type LoginResult = { ok: true; accountId: string } | { ok: false; reason: 'invalid' | 'deactivated' }`
  - `verifyLogin(db: Db, email: string, password: string): Promise<LoginResult>`
  - `makeFindAccount(db: Db): FindAccount` — `sub` is the user id; only `sub` is ever released as a claim
  - `class LoginThrottle { check(ip: string, nowMs: number): boolean; record(ip: string, nowMs: number): void }`

- [ ] **Step 1: Write the failing tests**

Create `apps/auth/test/login-throttle.test.ts` (the console's test, re-pointed):

```ts
import { describe, expect, test } from 'vitest'
import { LoginThrottle } from '../src/login-throttle.js'

describe('LoginThrottle', () => {
  test('blocks after 5 failures in the window, resets after it elapses', () => {
    const t = new LoginThrottle()
    let now = 0
    for (let i = 0; i < 5; i++) { expect(t.check('1.2.3.4', now)).toBe(true); t.record('1.2.3.4', now) }
    expect(t.check('1.2.3.4', now)).toBe(false)            // 6th blocked
    expect(t.check('9.9.9.9', now)).toBe(true)             // other IP unaffected
    now += 15 * 60_000 + 1
    expect(t.check('1.2.3.4', now)).toBe(true)             // window elapsed
  })
})
```

Create `apps/auth/test/account.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '@metamodels/schema'
import { verifyPassword } from '@metamodels/schema'
import { DUMMY_PASSWORD_HASH, makeFindAccount, verifyLogin } from '../src/account.js'
import { makeDb, seedUser } from './helpers/db.js'

const ctx = {} as never // findAccount never reads ctx

describe('verifyLogin', () => {
  test('accepts correct credentials for an active user and returns the user id', async () => {
    const db = await makeDb()
    const id = await seedUser(db, { email: 'admin@x.io', password: 'hunter2hunter2' })
    expect(await verifyLogin(db, 'admin@x.io', 'hunter2hunter2')).toEqual({ ok: true, accountId: id })
  })

  test('rejects a wrong password and an unknown email identically', async () => {
    const db = await makeDb()
    await seedUser(db, { email: 'admin@x.io', password: 'hunter2hunter2' })
    expect(await verifyLogin(db, 'admin@x.io', 'nope')).toEqual({ ok: false, reason: 'invalid' })
    expect(await verifyLogin(db, 'ghost@x.io', 'whatever')).toEqual({ ok: false, reason: 'invalid' })
  })

  test('rejects a deactivated user distinctly — but only after the password checks out', async () => {
    const db = await makeDb()
    await seedUser(db, { email: 'admin@x.io', password: 'hunter2hunter2', status: 'deactivated' })
    expect(await verifyLogin(db, 'admin@x.io', 'hunter2hunter2')).toEqual({ ok: false, reason: 'deactivated' })
    expect(await verifyLogin(db, 'admin@x.io', 'wrong')).toEqual({ ok: false, reason: 'invalid' })
  })

  test('treats an unrecognised role as invalid', async () => {
    const db = await makeDb()
    await seedUser(db, { email: 'odd@x.io', password: 'hunter2hunter2', role: 'owner' })
    expect(await verifyLogin(db, 'odd@x.io', 'hunter2hunter2')).toEqual({ ok: false, reason: 'invalid' })
  })

  test('DUMMY_PASSWORD_HASH is a well-formed scrypt hash the KDF actually processes', async () => {
    expect(DUMMY_PASSWORD_HASH).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/)
    expect(await verifyPassword('anything', DUMMY_PASSWORD_HASH)).toBe(false)
  })
})

describe('makeFindAccount', () => {
  test('finds an active user and releases only the sub claim', async () => {
    const db = await makeDb()
    const id = await seedUser(db, { email: 'a@x.io', password: 'hunter2hunter2' })
    const account = await makeFindAccount(db)(ctx, id)
    expect(account?.accountId).toBe(id)
    expect(await account!.claims('id_token', 'openid', {}, [])).toEqual({ sub: id })
  })

  test('returns undefined for a deactivated user, so existing sessions stop working', async () => {
    const db = await makeDb()
    const id = await seedUser(db, { email: 'a@x.io', password: 'hunter2hunter2' })
    await db.update(schema.user).set({ status: 'deactivated' }).where(eq(schema.user.id, id))
    expect(await makeFindAccount(db)(ctx, id)).toBeUndefined()
  })

  test('returns undefined for an unknown id and for a non-uuid id without querying badly', async () => {
    const db = await makeDb()
    expect(await makeFindAccount(db)(ctx, '00000000-0000-4000-8000-000000000000')).toBeUndefined()
    expect(await makeFindAccount(db)(ctx, 'not-a-uuid')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run apps/auth/test/account.test.ts apps/auth/test/login-throttle.test.ts`
Expected: FAIL — `../src/account.js` and `../src/login-throttle.js` cannot be resolved.

- [ ] **Step 3: Implement**

Create `apps/auth/src/login-throttle.ts` — byte-identical to `apps/control-plane/src/auth/login-throttle.ts`:

```ts
const MAX_FAILURES = 5
const WINDOW_MS = 15 * 60_000

interface Bucket { count: number; resetAt: number }

export class LoginThrottle {
  private readonly buckets = new Map<string, Bucket>()

  check(ip: string, nowMs: number): boolean {
    const b = this.buckets.get(ip)
    if (!b || nowMs >= b.resetAt) return true
    return b.count < MAX_FAILURES
  }

  record(ip: string, nowMs: number): void {
    const b = this.buckets.get(ip)
    if (!b || nowMs >= b.resetAt) {
      this.buckets.set(ip, { count: 1, resetAt: nowMs + WINDOW_MS })
      return
    }
    b.count += 1
  }
}
```

Create `apps/auth/src/account.ts`:

```ts
import { eq } from 'drizzle-orm'
import { USER_ROLES, user, verifyPassword } from '@metamodels/schema'
import type { Account, FindAccount } from 'oidc-provider'
import type { Db } from './db.js'

/**
 * A fixed, well-formed scrypt hash used ONLY to spend equivalent KDF time on the
 * unknown-email path, so login latency does not reveal whether an email exists.
 * The value is a throwaway — it never matches any real password.
 */
export const DUMMY_PASSWORD_HASH =
  'scrypt$6d081b91a6b7f71ca147f3f40fbaa91e$1b55a743a37ee80e7baf5d576b88b02c1e8bb5c1f8af173265829ea33c7df0582caa90bc1ad236c3e5be2e9a47c15462f2397cd59cc498cdb1c4c2960d4b84d8'

export type LoginResult =
  | { ok: true; accountId: string }
  | { ok: false; reason: 'invalid' | 'deactivated' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isKnownRole(role: string): boolean {
  return (USER_ROLES as readonly string[]).includes(role)
}

export async function verifyLogin(db: Db, email: string, password: string): Promise<LoginResult> {
  const rows = await db.select().from(user).where(eq(user.email, email)).limit(1)
  const u = rows[0]
  if (!u) {
    // Spend equivalent scrypt time so an unknown email is timing-indistinguishable
    // from a known email with a wrong password. Result is intentionally discarded.
    await verifyPassword(password, DUMMY_PASSWORD_HASH)
    return { ok: false, reason: 'invalid' }
  }
  const passwordOk = await verifyPassword(password, u.passwordHash)
  if (!passwordOk) return { ok: false, reason: 'invalid' }
  if (u.status !== 'active') return { ok: false, reason: 'deactivated' }
  if (!isKnownRole(u.role)) return { ok: false, reason: 'invalid' }
  return { ok: true, accountId: u.id }
}

/**
 * oidc-provider's account lookup. Re-reads the user on every call, so deactivating a user ends
 * their ability to obtain new tokens immediately. Releases only `sub`: the console and resource
 * servers load everything else (org, role, email) from the database by that id.
 */
export function makeFindAccount(db: Db): FindAccount {
  return async (_ctx, sub) => {
    if (!UUID.test(sub)) return undefined
    const rows = await db.select({ id: user.id, status: user.status }).from(user).where(eq(user.id, sub)).limit(1)
    const u = rows[0]
    if (!u || u.status !== 'active') return undefined
    const account: Account = { accountId: u.id, claims: () => ({ sub: u.id }) }
    return account
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run apps/auth/test/account.test.ts apps/auth/test/login-throttle.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Type-check and commit**

Run: `pnpm exec tsc -b apps/auth`
Expected: exit 0.

```bash
git add apps/auth/src/account.ts apps/auth/src/login-throttle.ts apps/auth/test/account.test.ts apps/auth/test/login-throttle.test.ts
git commit -m "feat(auth): account lookup, login verification and throttle"
```

---

### Task 6: Views, stylesheet and CSP

Every page the auth service renders is plain server-side HTML with one external stylesheet — no inline script, no inline style — so its Content-Security-Policy can be static and strict. The login form keeps the console's exact labels (`Email`, `Password`, `Sign in`) so the existing Playwright login helper needs no change.

**Files:**
- Create: `apps/auth/src/views.ts`
- Create: `apps/auth/test/views.test.ts`

**Interfaces:**
- Produces:
  - `escapeHtml(value: string): string`
  - `AUTH_CSS: string` (served at `/assets/auth.css` by Task 7)
  - `authCsp(redirectOrigins: readonly string[]): string`
  - `renderLoginPage(opts: { uid: string; email?: string; error?: string }): string`
  - `renderMessagePage(title: string, message: string): string`
  - `renderLogoutPage(form: string): string`

- [ ] **Step 1: Write the failing tests**

Create `apps/auth/test/views.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import {
  AUTH_CSS, authCsp, escapeHtml, renderLoginPage, renderLogoutPage, renderMessagePage,
} from '../src/views.js'

function directives(csp: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const part of csp.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/)
    if (name) out[name] = values
  }
  return out
}

const ALL_PAGES = [
  renderLoginPage({ uid: 'u1', email: 'a@x.io', error: 'bad' }),
  renderMessagePage('Title', 'Message'),
  renderLogoutPage('<form id="op.logoutForm" method="post" action="/session/end/confirm"></form>'),
]

describe('escapeHtml', () => {
  test('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;')
  })
})

describe('renderLoginPage', () => {
  test('posts credentials to this interaction and keeps the console\'s labels', () => {
    const html = renderLoginPage({ uid: 'abc123' })
    expect(html).toContain('<form method="post" action="/interaction/abc123/login">')
    expect(html).toContain('<label for="email">Email</label>')
    expect(html).toContain('<label for="password">Password</label>')
    expect(html).toContain('<button type="submit">Sign in</button>')
    expect(html).not.toContain('role="alert"')
  })

  test('escapes a hostile prefilled email and error message', () => {
    const html = renderLoginPage({ uid: 'u', email: '"><script>alert(1)</script>', error: '<b>x</b>' })
    expect(html).not.toContain('<script>')
    expect(html).toContain('value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"')
    expect(html).toContain('<p class="error" role="alert">&lt;b&gt;x&lt;/b&gt;</p>')
  })

  test('a hostile uid cannot break out of the form action', () => {
    const html = renderLoginPage({ uid: 'x" onsubmit="evil' })
    expect(html).toContain('action="/interaction/x%22%20onsubmit%3D%22evil/login"')
  })
})

describe('renderMessagePage and renderLogoutPage', () => {
  test('escape title and message', () => {
    const html = renderMessagePage('<T>', '<M>')
    expect(html).toContain('<h1>&lt;T&gt;</h1>')
    expect(html).toContain('<p>&lt;M&gt;</p>')
  })

  test('the logout page embeds the provider\'s form verbatim and targets it', () => {
    const form = '<form id="op.logoutForm" method="post" action="/session/end/confirm"><input type="hidden" name="xsrf" value="t"/></form>'
    const html = renderLogoutPage(form)
    expect(html).toContain(form)
    expect(html).toContain('form="op.logoutForm" value="yes" name="logout">Sign out</button>')
  })
})

describe('CSP compatibility', () => {
  test('no page carries inline script or inline style', () => {
    for (const html of ALL_PAGES) {
      expect(html).not.toMatch(/<script/i)
      expect(html).not.toMatch(/<style/i)
      expect(html).not.toMatch(/\sstyle=/i)
      expect(html).toContain('<link rel="stylesheet" href="/assets/auth.css">')
    }
  })

  test('the stylesheet loads nothing external', () => {
    expect(AUTH_CSS).not.toMatch(/url\(|@import/)
  })

  test('authCsp is strict and lets forms redirect only to the given origins', () => {
    const d = directives(authCsp(['https://console.example.test']))
    expect(d['default-src']).toEqual(["'none'"])
    expect(d['style-src']).toEqual(["'self'"])
    expect(d['form-action']).toEqual(["'self'", 'https://console.example.test'])
    expect(d['frame-ancestors']).toEqual(["'none'"])
    expect(d['base-uri']).toEqual(["'none'"])
    expect(authCsp([])).not.toContain('unsafe-inline')
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run apps/auth/test/views.test.ts`
Expected: FAIL — `../src/views.js` cannot be resolved.

- [ ] **Step 3: Implement**

Create `apps/auth/src/views.ts`:

```ts
/** Escape text for HTML element content and double-quoted attribute values. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** The console's palette (apps/control-plane/src/app/globals.css), restated — this service has no bundler. */
export const AUTH_CSS = `:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#141110;color:#ece4d6;font:15px/1.5 ui-sans-serif,system-ui,sans-serif}
.card{width:360px;max-width:calc(100vw - 32px);border:1px solid #2e2620;border-radius:9px;background:#1a1614;padding:24px}
.brand{margin-bottom:24px;font:600 18px ui-monospace,monospace;color:#acb965}
h1{margin:0 0 12px;font-size:16px}
p{margin:0 0 16px;color:#9a8b7c}
label{display:block;margin-bottom:6px;font-size:13px}
input{width:100%;margin-bottom:16px;padding:8px 10px;border:1px solid #3a2f28;border-radius:7px;background:#141110;color:#ece4d6;font:inherit}
button{width:100%;padding:9px 12px;border:0;border-radius:7px;background:#acb965;color:#23260f;font:600 14px ui-sans-serif,system-ui,sans-serif;cursor:pointer}
button.secondary{margin-top:8px;background:transparent;color:#9a8b7c;border:1px solid #2e2620}
.error{color:#cf5f4b}
`

/**
 * The auth service's Content-Security-Policy. Static: no page has inline script or style, so no
 * nonce is needed. `form-action` lists every origin a form POST may end up redirecting to,
 * because Chrome enforces form-action across the redirect chain — the login POST ends at the
 * console's /auth/callback, and logout confirmation ends at the console's /login.
 */
export function authCsp(redirectOrigins: readonly string[]): string {
  return [
    "default-src 'none'",
    "style-src 'self'",
    "img-src 'self'",
    ['form-action', "'self'", ...redirectOrigins].join(' '),
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ')
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · MetaModels</title>
<link rel="stylesheet" href="/assets/auth.css">
</head>
<body>
<main class="card">
<div class="brand">MetaModels</div>
${body}
</main>
</body>
</html>`
}

export function renderLoginPage(opts: { uid: string; email?: string; error?: string }): string {
  const error = opts.error ? `<p class="error" role="alert">${escapeHtml(opts.error)}</p>\n` : ''
  return page('Sign in', `<form method="post" action="/interaction/${encodeURIComponent(opts.uid)}/login">
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(opts.email ?? '')}">
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
${error}<button type="submit">Sign in</button>
</form>`)
}

export function renderMessagePage(title: string, message: string): string {
  return page(title, `<h1>${escapeHtml(title)}</h1>\n<p>${escapeHtml(message)}</p>`)
}

/**
 * RP-initiated logout confirmation. `form` is oidc-provider's own hidden form (method, action and
 * xsrf token) — trusted library output, inserted verbatim; the buttons submit it by id.
 */
export function renderLogoutPage(form: string): string {
  return page('Sign out', `<h1>Sign out of MetaModels?</h1>
${form}
<button autofocus type="submit" form="op.logoutForm" value="yes" name="logout">Sign out</button>
<button class="secondary" type="submit" form="op.logoutForm">Stay signed in</button>`)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run apps/auth/test/views.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/auth/src/views.ts apps/auth/test/views.test.ts
git commit -m "feat(auth): server-rendered views with a static strict CSP"
```

---

### Task 7: The provider, its interactions, and the full authorization-code flow

Assembles oidc-provider with the adapter, accounts, keys and views, and adds the Koa middleware that renders the login form, verifies passwords, and auto-consents **first-party** clients only. The tests drive the whole browser flow against a real in-process OP over HTTP and verify the resulting ID token with `jose`.

Two decisions encoded here, both from the spec's §7 amendments:
- **Only first-party clients get automatic consent.** Any other client that reaches the consent prompt is refused with `access_denied`. M4 builds a real consent screen; until then refusing is the only safe answer.
- **PKCE is required for every client**, confidential ones included (OAuth 2.1).

**Files:**
- Create: `apps/auth/src/interactions.ts`
- Create: `apps/auth/src/provider.ts`
- Create: `apps/auth/test/helpers/flow.ts`
- Create: `apps/auth/test/provider.test.ts`

**Interfaces:**
- Consumes: `CONSOLE_CLIENT_ID` (Task 1, from `@metamodels/schema`), `pgAdapterFactory` (Task 4), `makeFindAccount`, `verifyLogin`, `LoginThrottle` (Task 5), `signingJwks`, `AuthConfig` (Task 3), views (Task 6).
- Produces:
  - `consoleClient(cfg: AuthConfig): ClientMetadata`
  - `createProvider(cfg: AuthConfig, db: Db, opts?: { extraClients?: readonly ClientMetadata[] }): Provider` — `extraClients` are registered but never auto-consented
  - `interactionMiddleware(deps: InteractionDeps): Middleware` with `InteractionDeps = { provider, db, throttle, firstPartyClientIds, csp }`
  - HTTP surface: `GET /healthz`, `GET /assets/auth.css`, `GET /interaction/:uid`, `POST /interaction/:uid/login`, plus oidc-provider's default routes (`/auth`, `/token`, `/jwks`, `/session/end`, `/.well-known/openid-configuration`, `/me`)
  - Test helpers: `startTestOp(opts?)`, `CookieJar`, `send(jar, url, init?)`, `authorize(op, opts?)`, `exchangeCode(op, code, verifier, extra?)`, `opJwks(op)`, constants `CONSOLE_URL`, `CONSOLE_SECRET`, `REDIRECT_URI`

- [ ] **Step 1: Write the flow helpers**

Create `apps/auth/test/helpers/flow.ts`:

```ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { createLocalJWKSet, type JSONWebKeySet } from 'jose'
import type { ClientMetadata } from 'oidc-provider'
import type { AuthConfig } from '../../src/config.js'
import { CONSOLE_CLIENT_ID } from '@metamodels/schema'
import { createProvider } from '../../src/provider.js'
import { makeDb, type TestDb } from './db.js'

export const CONSOLE_URL = 'http://console.test'
export const CONSOLE_SECRET = 'console-secret-0123456789'
export const REDIRECT_URI = `${CONSOLE_URL}/auth/callback`

export interface TestOp {
  issuer: string
  db: TestDb
  close(): Promise<void>
}

/** A real OP on an ephemeral port, backed by a fresh pglite database. */
export async function startTestOp(opts: { extraClients?: ClientMetadata[] } = {}): Promise<TestOp> {
  const db = await makeDb()
  let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => { res.statusCode = 503; res.end() }
  const server = createServer((req, res) => handler(req, res))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  // The issuer must be known before the provider exists, so the port is taken first.
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const cfg: AuthConfig = {
    issuer,
    consoleUrl: CONSOLE_URL,
    consoleClientSecret: CONSOLE_SECRET,
    cookieKeys: ['cookie-key-0123456789abcdef'],
    signingKeyPem: null,
    allowEphemeralKey: true,
    databaseUrl: 'unused-in-tests',
    port: 0,
  }
  handler = createProvider(cfg, db, opts).callback()
  return {
    issuer,
    db,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}

/** Just enough of a browser cookie store: ignores Path/Domain, honours deletion. */
export class CookieJar {
  private readonly cookies = new Map<string, string>()

  store(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';')
      const eq = pair.indexOf('=')
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      const expired = attrs.some((a) => /^\s*expires=Thu, 01 Jan 1970/i.test(a) || /^\s*max-age=0\s*$/i.test(a))
      if (expired || value === '') this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }
}

/** One request, redirects NOT followed, cookies sent and stored. */
export async function send(jar: CookieJar, url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  const cookie = jar.header()
  if (cookie) headers.set('cookie', cookie)
  const res = await fetch(url, { ...init, headers, redirect: 'manual' })
  jar.store(res)
  return res
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

export type AuthorizeOutcome =
  | { kind: 'redirect'; url: URL; verifier: string; jar: CookieJar }
  | { kind: 'page'; status: number; body: string; verifier: string; jar: CookieJar }

export interface AuthorizeOptions {
  email?: string
  password?: string
  clientId?: string
  redirectUri?: string
  scope?: string
  pkce?: boolean
  extra?: Record<string, string>
  headers?: Record<string, string>
}

/**
 * Drive the browser half of the authorization-code flow. Submits the login form once (when
 * `email` is given) and follows redirects until the client's redirect_uri — or stops at the first
 * page that is not a login form it is about to submit.
 */
export async function authorize(op: TestOp, o: AuthorizeOptions = {}): Promise<AuthorizeOutcome> {
  const jar = new CookieJar()
  const { verifier, challenge } = pkcePair()
  const redirectUri = o.redirectUri ?? REDIRECT_URI
  const url = new URL(`${op.issuer}/auth`)
  url.search = new URLSearchParams({
    client_id: o.clientId ?? CONSOLE_CLIENT_ID,
    response_type: 'code',
    scope: o.scope ?? 'openid',
    redirect_uri: redirectUri,
    state: 'state-123',
    nonce: 'nonce-456',
    ...(o.pkce === false ? {} : { code_challenge: challenge, code_challenge_method: 'S256' }),
    ...o.extra,
  }).toString()

  let res = await send(jar, url.href, { headers: o.headers })
  let submitted = false
  for (let hop = 0; hop < 12; hop++) {
    if (res.status >= 300 && res.status < 400) {
      const next = new URL(res.headers.get('location')!, op.issuer)
      if (next.href.startsWith(redirectUri)) return { kind: 'redirect', url: next, verifier, jar }
      res = await send(jar, next.href, { headers: o.headers })
      continue
    }
    const body = await res.text()
    const action = /<form method="post" action="([^"]+)">/.exec(body)?.[1]
    if (action && !submitted && o.email !== undefined) {
      submitted = true
      res = await send(jar, new URL(action, op.issuer).href, {
        method: 'POST',
        headers: { ...o.headers, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email: o.email, password: o.password ?? '' }).toString(),
      })
      continue
    }
    return { kind: 'page', status: res.status, body, verifier, jar }
  }
  throw new Error('authorize(): too many redirects')
}

/** The console's back-channel token request, with client_secret_basic authentication. */
export async function exchangeCode(
  op: TestOp, code: string, verifier: string, extra: Record<string, string> = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const basic = Buffer.from(`${encodeURIComponent(CONSOLE_CLIENT_ID)}:${encodeURIComponent(CONSOLE_SECRET)}`).toString('base64')
  const res = await fetch(`${op.issuer}/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: verifier, ...extra,
    }).toString(),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

export async function opJwks(op: TestOp) {
  return createLocalJWKSet((await (await fetch(`${op.issuer}/jwks`)).json()) as JSONWebKeySet)
}
```

- [ ] **Step 2: Write the failing flow tests**

Create `apps/auth/test/provider.test.ts`:

```ts
import { afterEach, describe, expect, test } from 'vitest'
import { jwtVerify } from 'jose'
import { CONSOLE_CLIENT_ID } from '@metamodels/schema'
import { seedUser } from './helpers/db.js'
import { authorize, exchangeCode, opJwks, send, startTestOp, type TestOp } from './helpers/flow.js'

const T = 20_000
let op: TestOp | undefined
afterEach(async () => { await op?.close(); op = undefined })

describe('auth service — discovery and plumbing', () => {
  test('publishes discovery with PKCE S256, RFC 9207 iss, logout, and no dynamic registration', async () => {
    op = await startTestOp()
    const meta = await (await fetch(`${op.issuer}/.well-known/openid-configuration`)).json()
    expect(meta.issuer).toBe(op.issuer)
    expect(meta.code_challenge_methods_supported).toContain('S256')
    expect(meta.authorization_response_iss_parameter_supported).toBe(true)
    expect(meta.end_session_endpoint).toBe(`${op.issuer}/session/end`)
    expect(meta.registration_endpoint).toBeUndefined()
  }, T)

  test('health, stylesheet and security headers are served', async () => {
    op = await startTestOp()
    const health = await fetch(`${op.issuer}/healthz`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ok: true })
    expect(health.headers.get('content-security-policy')).toContain("form-action 'self' http://console.test")
    expect(health.headers.get('x-frame-options')).toBe('DENY')
    const css = await fetch(`${op.issuer}/assets/auth.css`)
    expect(css.status).toBe(200)
    expect(css.headers.get('content-type')).toContain('text/css')
  }, T)
})

describe('auth service — authorization code flow', () => {
  test('a valid login completes the flow and yields an ID token for that user', async () => {
    op = await startTestOp()
    const id = await seedUser(op.db, { email: 'admin@x.io', password: 'hunter2hunter2' })
    const out = await authorize(op, { email: 'admin@x.io', password: 'hunter2hunter2' })
    if (out.kind !== 'redirect') throw new Error(`expected a redirect, got ${out.status}: ${out.body.slice(0, 200)}`)
    expect(out.url.searchParams.get('state')).toBe('state-123')
    expect(out.url.searchParams.get('iss')).toBe(op.issuer)

    const token = await exchangeCode(op, out.url.searchParams.get('code')!, out.verifier)
    expect(token.status).toBe(200)
    const { payload } = await jwtVerify(token.json.id_token as string, await opJwks(op), {
      issuer: op.issuer, audience: CONSOLE_CLIENT_ID, algorithms: ['RS256'],
    })
    expect(payload.sub).toBe(id)
    expect(payload.nonce).toBe('nonce-456')
  }, T)

  test('an authorization code is single-use', async () => {
    op = await startTestOp()
    await seedUser(op.db, { email: 'admin@x.io', password: 'hunter2hunter2' })
    const out = await authorize(op, { email: 'admin@x.io', password: 'hunter2hunter2' })
    if (out.kind !== 'redirect') throw new Error('expected a redirect')
    const code = out.url.searchParams.get('code')!
    expect((await exchangeCode(op, code, out.verifier)).status).toBe(200)
    const replay = await exchangeCode(op, code, out.verifier)
    expect(replay.status).toBe(400)
    expect(replay.json.error).toBe('invalid_grant')
  }, T)

  test('a wrong password and an unknown email get the same generic error', async () => {
    op = await startTestOp()
    await seedUser(op.db, { email: 'admin@x.io', password: 'hunter2hunter2' })
    for (const [email, password] of [['admin@x.io', 'wrong'], ['ghost@x.io', 'hunter2hunter2']]) {
      const out = await authorize(op, { email, password })
      if (out.kind !== 'page') throw new Error('expected the login page again')
      expect(out.status).toBe(401)
      expect(out.body).toContain('Invalid email or password.')
    }
  }, T)

  test('a deactivated account is told so', async () => {
    op = await startTestOp()
    await seedUser(op.db, { email: 'gone@x.io', password: 'hunter2hunter2', status: 'deactivated' })
    const out = await authorize(op, { email: 'gone@x.io', password: 'hunter2hunter2' })
    if (out.kind !== 'page') throw new Error('expected the login page again')
    expect(out.body).toContain('This account is deactivated.')
  }, T)

  test('login_hint pre-fills the email field', async () => {
    op = await startTestOp()
    const out = await authorize(op, { extra: { login_hint: 'hint@x.io' } })
    if (out.kind !== 'page') throw new Error('expected the login page')
    expect(out.status).toBe(200)
    expect(out.body).toContain('value="hint@x.io"')
  }, T)

  test('PKCE is mandatory, even for the confidential console client', async () => {
    op = await startTestOp()
    const out = await authorize(op, { pkce: false })
    if (out.kind !== 'redirect') throw new Error('expected an error redirect to the client')
    expect(out.url.searchParams.get('error')).toBe('invalid_request')
  }, T)

  test('an unregistered redirect_uri is never redirected to', async () => {
    op = await startTestOp()
    const out = await authorize(op, { redirectUri: 'http://evil.test/cb' })
    expect(out.kind).toBe('page')
    if (out.kind === 'page') expect(out.status).toBe(400)
  }, T)

  test('five failures lock out an address; another address is unaffected', async () => {
    op = await startTestOp()
    await seedUser(op.db, { email: 'admin@x.io', password: 'hunter2hunter2' })
    const first = await authorize(op)
    if (first.kind !== 'page') throw new Error('expected the login page')
    const action = new URL(/action="([^"]+)"/.exec(first.body)![1], op.issuer).href
    const post = (password: string, ip: string) => send(first.jar, action, {
      method: 'POST',
      headers: { 'x-forwarded-for': ip, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'admin@x.io', password }).toString(),
    })
    for (let i = 0; i < 5; i++) expect((await post('wrong', '203.0.113.7')).status).toBe(401)
    expect((await post('hunter2hunter2', '203.0.113.7')).status).toBe(429)
    expect((await post('hunter2hunter2', '198.51.100.2')).status).toBe(303)
  }, T)

  test('a third-party client is refused at consent instead of being silently granted', async () => {
    op = await startTestOp({
      extraClients: [{
        client_id: 'third-party',
        client_secret: 'third-party-secret-0123',
        redirect_uris: ['http://third.test/cb'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
      }],
    })
    await seedUser(op.db, { email: 'admin@x.io', password: 'hunter2hunter2' })
    const out = await authorize(op, {
      clientId: 'third-party', redirectUri: 'http://third.test/cb', email: 'admin@x.io', password: 'hunter2hunter2',
    })
    if (out.kind !== 'redirect') throw new Error('expected an error redirect to the client')
    expect(out.url.searchParams.get('error')).toBe('access_denied')
    expect(out.url.searchParams.get('code')).toBeNull()
  }, T)
})
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm exec vitest run apps/auth/test/provider.test.ts`
Expected: FAIL — `../src/provider.js` cannot be resolved.

- [ ] **Step 4: Implement the interaction middleware**

Create `apps/auth/src/interactions.ts`:

```ts
import type { IncomingMessage } from 'node:http'
import type { Middleware, ParameterizedContext } from 'koa'
import type Provider from 'oidc-provider'
import { errors } from 'oidc-provider'
import { verifyLogin } from './account.js'
import type { Db } from './db.js'
import type { LoginThrottle } from './login-throttle.js'
import { AUTH_CSS, renderLoginPage, renderMessagePage } from './views.js'

type Ctx = ParameterizedContext
type InteractionDetails = Awaited<ReturnType<Provider['interactionDetails']>>

export interface InteractionDeps {
  provider: Provider
  db: Db
  throttle: LoginThrottle
  /** Clients that ARE MetaModels, so consent is implied. Everyone else is refused until M4's consent screen. */
  firstPartyClientIds: ReadonlySet<string>
  csp: string
}

const INTERACTION_PATH = /^\/interaction\/([A-Za-z0-9_-]+)(\/login)?$/
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
      if (ctx.method === 'POST' && match[2]) return await submitLogin(ctx, deps)
      ctx.status = 405
      ctx.set('Allow', match[2] ? 'POST' : 'GET')
    } catch (err) {
      if (err instanceof errors.SessionNotFound) {
        html(ctx, 400, renderMessagePage(
          'Sign-in expired',
          'This sign-in attempt has expired or was already completed. Go back to the console and sign in again.',
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
    if (!deps.firstPartyClientIds.has(String(params.client_id))) {
      await deps.provider.interactionFinished(ctx.req, ctx.res, {
        error: 'access_denied',
        error_description: 'This client is not permitted to sign in yet.',
      }, { mergeWithLastSubmission: false })
      return
    }
    const consent = await consentFor(deps.provider, details)
    await deps.provider.interactionFinished(ctx.req, ctx.res, { consent }, { mergeWithLastSubmission: true })
    return
  }

  html(ctx, 400, renderMessagePage('Unsupported request', `This sign-in step (${prompt.name}) is not supported.`))
}

/**
 * Automatic consent for a first-party client: grant exactly what this request is missing, and
 * nothing more. Mirrors oidc-provider's reference consent handler, minus the screen.
 */
async function consentFor(provider: Provider, details: InteractionDetails): Promise<{ grantId?: string }> {
  const accountId = details.session?.accountId
  if (!accountId) throw new Error('consent prompt reached without an authenticated session')

  const existing = details.grantId ? await provider.Grant.find(details.grantId) : undefined
  const grant = existing ?? new provider.Grant({ accountId, clientId: String(details.params.client_id) })

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

`interactionFinished` writes the 303 straight to the Node response; Koa sees the response ended and does not write again, which is how oidc-provider's own Koa example uses it.

- [ ] **Step 5: Assemble the provider**

Create `apps/auth/src/provider.ts`:

```ts
import Provider, { type ClientMetadata, type Configuration } from 'oidc-provider'
import { CONSOLE_CLIENT_ID } from '@metamodels/schema'
import { makeFindAccount } from './account.js'
import { pgAdapterFactory } from './adapter.js'
import type { AuthConfig } from './config.js'
import type { Db } from './db.js'
import { interactionMiddleware } from './interactions.js'
import { signingJwks } from './keys.js'
import { LoginThrottle } from './login-throttle.js'
import { authCsp, renderLogoutPage, renderMessagePage } from './views.js'

export interface ProviderOptions {
  /** More statically registered clients. Never auto-consented: M1 refuses them at the consent prompt. */
  extraClients?: readonly ClientMetadata[]
}

/** The operator console — a confidential client using the authorization-code flow with PKCE. */
export function consoleClient(cfg: AuthConfig): ClientMetadata {
  return {
    client_id: CONSOLE_CLIENT_ID,
    client_secret: cfg.consoleClientSecret,
    client_name: 'MetaModels console',
    redirect_uris: [`${cfg.consoleUrl}/auth/callback`],
    post_logout_redirect_uris: [`${cfg.consoleUrl}/login`],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_basic',
  }
}

export function createProvider(cfg: AuthConfig, db: Db, opts: ProviderOptions = {}): Provider {
  const configuration: Configuration = {
    adapter: pgAdapterFactory(db),
    clients: [consoleClient(cfg), ...(opts.extraClients ?? [])],
    cookies: { keys: cfg.cookieKeys },
    jwks: signingJwks(cfg.signingKeyPem, cfg.allowEphemeralKey),
    findAccount: makeFindAccount(db),
    // OAuth 2.1: PKCE for every client, confidential ones included.
    pkce: { required: () => true },
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    features: {
      devInteractions: { enabled: false },
      rpInitiatedLogout: {
        enabled: true,
        logoutSource: (ctx, form) => {
          ctx.type = 'html'
          ctx.body = renderLogoutPage(form)
        },
        postLogoutSuccessSource: (ctx) => {
          ctx.type = 'html'
          ctx.body = renderMessagePage('Signed out', 'You have been signed out of MetaModels.')
        },
      },
    },
    renderError: (ctx, out) => {
      ctx.type = 'html'
      ctx.body = renderMessagePage('Sign-in error', out.error_description ?? out.error)
    },
    ttl: {
      AccessToken: 60 * 60,
      AuthorizationCode: 60,
      IdToken: 60 * 60,
      Interaction: 10 * 60,
      Session: 14 * 24 * 60 * 60,
      Grant: 14 * 24 * 60 * 60,
    },
  }

  const provider = new Provider(cfg.issuer, configuration)
  // Deployed behind a TLS-terminating proxy or tunnel: trust X-Forwarded-Proto/For so issued URLs
  // and cookie `secure` flags are right (oidc-provider docs, "Trusting TLS offloading proxies").
  provider.proxy = true
  provider.use(interactionMiddleware({
    provider,
    db,
    throttle: new LoginThrottle(),
    firstPartyClientIds: new Set([CONSOLE_CLIENT_ID]),
    csp: authCsp([new URL(cfg.consoleUrl).origin]),
  }))
  return provider
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm exec vitest run apps/auth/test/provider.test.ts`
Expected: PASS, 11 tests.

If `the third-party client` test fails with a `code` instead of `error=access_denied`, the consent prompt was skipped — stop and report rather than loosening the assertion: silently granting a third party is the failure this test exists to catch.

Run: `pnpm exec vitest run apps/auth`
Expected: PASS — every auth-service suite so far (config, keys, adapter, account, login-throttle, views, provider).

- [ ] **Step 7: Type-check and commit**

Run: `pnpm exec tsc -b apps/auth`
Expected: exit 0.

```bash
git add apps/auth/src/interactions.ts apps/auth/src/provider.ts apps/auth/test/helpers/flow.ts apps/auth/test/provider.test.ts
git commit -m "feat(auth): oidc-provider with login interaction and first-party consent"
```

---

### Task 8: Resource servers — the access-token contract for M2 and M4

M1 ships no resource server, but it must ship the **token contract** that M2 (admin API) and M4 (per-paddock MCP) will verify — that is why those plans are written after this one. RFC 8707 resource indicators are enabled; the only resource M1 declares is the admin API. Its scope values are exactly `CAPABILITIES`, so M2 can intersect a token's scopes with the user's role (spec §2.2).

**Token contract** (what M2 and M4 rely on — changing it is a breaking change):

| Property | Value |
|---|---|
| Format | RFC 9068 JWT, JWS header `alg: RS256`, `typ: at+jwt`, `kid` = RFC 7638 thumbprint |
| `iss` | `OIDC_ISSUER` |
| `aud` | the resource indicator; for the admin API exactly `${CONSOLE_URL}/api/admin` |
| `sub` | the user's id (uuid) — resource servers reload the user from the database by it |
| `client_id` | the requesting client |
| `scope` | space-separated; only values the client requested AND the resource defines |
| `exp` − `iat` | 3600 s |
| Verification | signature against `${OIDC_ISSUER}/jwks`; exact `iss`, `aud`, `typ`; `exp` |

**Files:**
- Create: `apps/auth/src/resources.ts`
- Create: `apps/auth/test/resources.test.ts`
- Modify: `apps/auth/src/provider.ts` (`features` block and imports)

**Interfaces:**
- Consumes: `CAPABILITIES`, `adminApiResource` (Task 1), `createProvider` (Task 7), flow helpers (Task 7).
- Produces:
  - `resourceServers(consoleUrl: string): ReadonlyMap<string, ResourceServer>`
  - `makeGetResourceServerInfo(servers): (ctx: unknown, resourceIndicator: string) => Promise<ResourceServer>` — throws `errors.InvalidTarget` for anything undeclared

- [ ] **Step 1: Write the failing tests**

Create `apps/auth/test/resources.test.ts`:

```ts
import { afterEach, describe, expect, test } from 'vitest'
import { jwtVerify } from 'jose'
import { adminApiResource, CAPABILITIES, CONSOLE_CLIENT_ID } from '@metamodels/schema'
import { resourceServers } from '../src/resources.js'
import { seedUser } from './helpers/db.js'
import { authorize, CONSOLE_URL, exchangeCode, opJwks, startTestOp, type TestOp } from './helpers/flow.js'

const T = 20_000
const ADMIN = adminApiResource(CONSOLE_URL)
let op: TestOp | undefined
afterEach(async () => { await op?.close(); op = undefined })

async function signedIn(scope: string, resource?: string) {
  op = await startTestOp()
  const id = await seedUser(op.db, { email: 'admin@x.io', password: 'hunter2hunter2' })
  const out = await authorize(op, {
    email: 'admin@x.io', password: 'hunter2hunter2', scope, extra: resource ? { resource } : {},
  })
  return { id, out }
}

describe('resource servers', () => {
  test('the admin API resource declares exactly the capability scopes', () => {
    const rs = resourceServers(CONSOLE_URL).get(ADMIN)
    expect(ADMIN).toBe('http://console.test/api/admin')
    expect(rs?.scope.split(' ')).toEqual([...CAPABILITIES])
    expect(rs?.accessTokenFormat).toBe('jwt')
  })

  test('requesting the admin API yields an RFC 9068 JWT bound to it', async () => {
    const { id, out } = await signedIn('openid read resource.write', ADMIN)
    if (out.kind !== 'redirect' || !out.url.searchParams.get('code')) throw new Error('expected a code')
    const token = await exchangeCode(op!, out.url.searchParams.get('code')!, out.verifier, { resource: ADMIN })
    expect(token.status).toBe(200)

    const { payload, protectedHeader } = await jwtVerify(token.json.access_token as string, await opJwks(op!), {
      issuer: op!.issuer, audience: ADMIN, typ: 'at+jwt', algorithms: ['RS256'],
    })
    expect(protectedHeader.alg).toBe('RS256')
    expect(payload.sub).toBe(id)
    expect(payload.client_id).toBe(CONSOLE_CLIENT_ID)
    expect(String(payload.scope).split(' ').sort()).toEqual(['read', 'resource.write'])
    expect(typeof payload.jti).toBe('string')
    expect(payload.exp! - payload.iat!).toBe(3600)
  }, T)

  test('a token carries only the scopes that were asked for', async () => {
    const { out } = await signedIn('openid read', ADMIN)
    if (out.kind !== 'redirect') throw new Error('expected a code')
    const token = await exchangeCode(op!, out.url.searchParams.get('code')!, out.verifier, { resource: ADMIN })
    const { payload } = await jwtVerify(token.json.access_token as string, await opJwks(op!), { issuer: op!.issuer, audience: ADMIN })
    expect(payload.scope).toBe('read')
  }, T)

  test('an undeclared resource is refused with invalid_target', async () => {
    const { out } = await signedIn('openid read', 'http://evil.test/api')
    if (out.kind !== 'redirect') throw new Error('expected an error redirect to the client')
    expect(out.url.searchParams.get('error')).toBe('invalid_target')
    expect(out.url.searchParams.get('code')).toBeNull()
  }, T)

  test('without a resource, no JWT access token is issued', async () => {
    const { out } = await signedIn('openid')
    if (out.kind !== 'redirect') throw new Error('expected a code')
    const token = await exchangeCode(op!, out.url.searchParams.get('code')!, out.verifier)
    expect(token.status).toBe(200)
    expect(String(token.json.access_token).split('.')).not.toHaveLength(3)
  }, T)
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run apps/auth/test/resources.test.ts`
Expected: FAIL — `../src/resources.js` cannot be resolved.

- [ ] **Step 3: Implement**

Create `apps/auth/src/resources.ts`:

```ts
import { errors, type ResourceServer } from 'oidc-provider'
import { adminApiResource, CAPABILITIES } from '@metamodels/schema'

/**
 * Every resource server this OP issues access tokens for. Tokens are RFC 9068 JWTs so resource
 * servers verify them offline against /jwks. This map IS the token contract M2 and M4 consume;
 * M4 adds one entry per published paddock.
 */
export function resourceServers(consoleUrl: string): ReadonlyMap<string, ResourceServer> {
  return new Map([[adminApiResource(consoleUrl), {
    scope: CAPABILITIES.join(' '),
    accessTokenFormat: 'jwt',
    accessTokenTTL: 60 * 60,
    jwt: { sign: { alg: 'RS256' } },
  }]])
}

/** oidc-provider's `getResourceServerInfo`: known resources only, everything else `invalid_target`. */
export function makeGetResourceServerInfo(servers: ReadonlyMap<string, ResourceServer>) {
  return async (_ctx: unknown, resourceIndicator: string): Promise<ResourceServer> => {
    const rs = servers.get(resourceIndicator)
    if (!rs) throw new errors.InvalidTarget()
    return rs
  }
}
```

In `apps/auth/src/provider.ts`, add the import:

```ts
import { makeGetResourceServerInfo, resourceServers } from './resources.js'
```

and add this entry to the `features` object, after `devInteractions`:

```ts
      resourceIndicators: {
        enabled: true,
        getResourceServerInfo: makeGetResourceServerInfo(resourceServers(cfg.consoleUrl)),
        // Clients must name the resource at the token endpoint as well; an openid-only exchange
        // returns an opaque userinfo token, never a resource-bound JWT.
        useGrantedResource: async () => false,
      },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run apps/auth/test/resources.test.ts apps/auth/test/provider.test.ts`
Expected: PASS, 16 tests (5 + 11) — enabling resource indicators must not change the plain sign-in flow.

- [ ] **Step 5: Type-check and commit**

Run: `pnpm exec tsc -b apps/auth`
Expected: exit 0.

```bash
git add apps/auth/src/resources.ts apps/auth/src/provider.ts apps/auth/test/resources.test.ts
git commit -m "feat(auth): RFC 8707 resource indicators with the admin-API JWT contract"
```

---

### Task 9: Entrypoint and documented environment

**Files:**
- Create: `apps/auth/src/server.ts`
- Create: `apps/auth/test/server.test.ts`
- Create: `apps/auth/test/env-docs.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `loadAuthConfig`, `createProvider`, `sweepExpired`.
- Produces: `startAuthServer(cfg: AuthConfig, db?: Db): Server` — listens on `cfg.port`, sweeps expired `oidc_payload` rows hourly (timer `unref`'d and cleared on close), warns loudly when signing with an ephemeral key.

- [ ] **Step 1: Write the failing tests**

Create `apps/auth/test/server.test.ts`:

```ts
import { expect, test } from 'vitest'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { AuthConfig } from '../src/config.js'
import { startAuthServer } from '../src/server.js'
import { makeDb } from './helpers/db.js'

test('serves the provider on the configured port and shuts down cleanly', async () => {
  const cfg: AuthConfig = {
    issuer: 'http://127.0.0.1:1',
    consoleUrl: 'http://console.test',
    consoleClientSecret: 'console-secret-0123456789',
    cookieKeys: ['cookie-key-0123456789abcdef'],
    signingKeyPem: null,
    allowEphemeralKey: true,
    databaseUrl: 'unused-db-is-injected',
    port: 0,
  }
  const server = startAuthServer(cfg, await makeDb())
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  const res = await fetch(`http://127.0.0.1:${port}/healthz`)
  expect(res.status).toBe(200)
  await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) })
}, 20_000)
```

Create `apps/auth/test/env-docs.test.ts`. The console's env keys are policed by `packages/schema/test/env-example.test.ts`, which scans for `process.env.X`; the auth service reads configuration through a parameter, so this test records every key `loadAuthConfig` actually touches instead:

```ts
import { expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadAuthConfig } from '../src/config.js'

test('.env.example documents every variable the auth service reads', () => {
  const seen = new Set<string>()
  const valid: Record<string, string | undefined> = {
    OIDC_ISSUER: 'https://auth.example.test',
    CONSOLE_URL: 'https://console.example.test',
    CONSOLE_CLIENT_SECRET: 'x'.repeat(16),
    OIDC_COOKIE_KEYS: 'y'.repeat(16),
    OIDC_ALLOW_EPHEMERAL_KEY: 'true',
    DATABASE_URL: 'postgres://x',
  }
  const env = new Proxy(valid, {
    get(target, key: string) { seen.add(key); return target[key] },
  })
  loadAuthConfig(env)

  const example = readFileSync(fileURLToPath(new URL('../../../.env.example', import.meta.url)), 'utf8')
  const documented = new Set(
    example.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.split('=')[0]),
  )
  expect(seen).toContain('OIDC_SIGNING_KEY') // proves the proxy saw the optional reads too
  expect([...seen].filter((k) => !documented.has(k)).sort()).toEqual([])
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run apps/auth/test/server.test.ts apps/auth/test/env-docs.test.ts`
Expected: FAIL — `../src/server.js` cannot be resolved, and the env-docs test lists `AUTH_PORT, CONSOLE_CLIENT_SECRET, CONSOLE_URL, OIDC_ALLOW_EPHEMERAL_KEY, OIDC_COOKIE_KEYS, OIDC_ISSUER, OIDC_SIGNING_KEY` as missing.

- [ ] **Step 3: Implement the entrypoint**

Create `apps/auth/src/server.ts`:

```ts
import { createServer, type Server } from 'node:http'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from '@metamodels/schema'
import { sweepExpired } from './adapter.js'
import { loadAuthConfig, type AuthConfig } from './config.js'
import type { Db } from './db.js'
import { createProvider } from './provider.js'

const SWEEP_INTERVAL_MS = 60 * 60 * 1000

/** Start the OP. `db` is injectable for tests; production builds a postgres-js client from DATABASE_URL. */
export function startAuthServer(cfg: AuthConfig, db: Db = drizzle(postgres(cfg.databaseUrl), { schema })): Server {
  if (!cfg.signingKeyPem) {
    // eslint-disable-next-line no-console
    console.warn('[auth] OIDC_ALLOW_EPHEMERAL_KEY: signing with a throwaway key — every token dies on restart. Development only.')
  }
  const server = createServer(createProvider(cfg, db).callback())

  const sweep = setInterval(() => {
    // eslint-disable-next-line no-console
    sweepExpired(db).catch((err) => console.error('[auth] expired-row sweep failed:', err))
  }, SWEEP_INTERVAL_MS)
  sweep.unref()
  server.on('close', () => clearInterval(sweep))

  server.listen(cfg.port, () => {
    // eslint-disable-next-line no-console
    console.log(`metamodels auth listening on :${cfg.port} (issuer ${cfg.issuer})`)
  })
  return server
}

// Only run when executed directly, not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith('server.ts')) {
  startAuthServer(loadAuthConfig(process.env))
}
```

- [ ] **Step 4: Document the environment**

In `.env.example`, insert this block directly after the `# --- Control-plane secrets …` block (after the `LICENSE_KEY_SECRET=` line):

```bash

# --- Auth service (OpenID Provider, apps/auth) ---
# Public URL browsers use to reach the auth service. It is also the token issuer, so it must be
# exactly what browsers and clients see. Origin only — no path.
OIDC_ISSUER=http://localhost:3100
# Public URL of the operator console. Origin only. Its redirect and post-logout URIs derive from
# it, so the port must match CONTROL_PLANE_PORT.
CONSOLE_URL=http://localhost:3000
# How the console reaches the auth service server-to-server (the compose network). Defaults to OIDC_ISSUER.
OIDC_INTERNAL_URL=http://auth:3100
# Listen port inside the auth container, and the host port compose publishes it on.
AUTH_PORT=3100
AUTH_HOST_PORT=3100
# Shared by the auth service and the console (>= 16 chars; openssl rand -hex 32).
CONSOLE_CLIENT_SECRET=change-me-console-client-secret
# Auth-service cookie-signing keys, comma-separated, newest first (each >= 16 chars).
OIDC_COOKIE_KEYS=change-me-oidc-cookie-signing-key
# Base64 of an RSA (>= 2048-bit) PKCS#8 PEM private key that signs every token. Generate with:
#   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 | openssl base64 -A
# Empty here because this file drives local development and CI. Production MUST set it.
OIDC_SIGNING_KEY=
# Local development and CI only: with OIDC_SIGNING_KEY empty, mint a throwaway key at boot.
# Every token dies with the process. Never set this in production.
OIDC_ALLOW_EPHEMERAL_KEY=true
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run apps/auth/test/server.test.ts apps/auth/test/env-docs.test.ts packages/schema/test/env-example.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Type-check and commit**

Run: `pnpm exec tsc -b apps/auth`
Expected: exit 0.

```bash
git add apps/auth/src/server.ts apps/auth/test/server.test.ts apps/auth/test/env-docs.test.ts .env.example
git commit -m "feat(auth): service entrypoint with expiry sweep and documented env"
```

---

### Task 10: The console's relying-party client

Pure OIDC client logic, testable without Next: discovery, the authorization URL, the back-channel code exchange, ID-token verification and the logout URL. Also generalises the session codec so the same HMAC primitive can seal the short-lived sign-in transaction cookie.

The **back channel** matters in Docker: browsers reach the OP at `OIDC_ISSUER` (a public URL), but inside the compose network the console must call `http://auth:3100`. The client fetches discovery, the token endpoint and the JWKS through `OIDC_INTERNAL_URL` while still requiring `iss` to equal the public issuer.

**Files:**
- Modify: `apps/control-plane/src/auth/session.ts`
- Modify: `apps/control-plane/src/auth/session.test.ts` (append)
- Create: `apps/control-plane/src/auth/oidc-client.ts`
- Create: `apps/control-plane/src/auth/oidc-client.test.ts`
- Modify: `apps/control-plane/package.json` (via `pnpm add`)

**Interfaces:**
- Consumes: `CONSOLE_CLIENT_ID` from `@metamodels/schema` (Task 1).
- Produces:
  - `sealJson(payload: Record<string, unknown>, secret: string, ttlMs: number, nowMs: number): string`
  - `openJson(token: string, secret: string, nowMs: number): Record<string, unknown> | null`
  - `interface OidcClientConfig { issuer: string; internalUrl: string; consoleUrl: string; clientSecret: string }`
  - `loadOidcClientConfig(env?): OidcClientConfig` (defaults to `process.env`)
  - `interface AuthTransaction { state: string; nonce: string; codeVerifier: string }`
  - `newTransaction(): AuthTransaction`, `codeChallenge(verifier: string): string`, `onOrigin(url: string, origin: string): string`
  - `class OidcError extends Error`
  - `class OidcClient` — `constructor(cfg, now?)`, `redirectUri`, `postLogoutRedirectUri`, `metadata()`, `authorizationUrl(tx, loginHint?)`, `exchangeCode(code, tx): Promise<{ sub: string }>`, `endSessionUrl()`

- [ ] **Step 1: Vet and add `jose` to the console**

`jose` was vetted in Task 3 (zero dependencies, no install scripts, provenance).

```bash
pnpm --filter @metamodels/control-plane add jose@^6.2.12
```

Run: `git diff pnpm-lock.yaml | grep -E '^\+  [@a-z][^ ]*@[0-9][^ ]*:$'`
Expected: no new package entries — `jose` is already in the lockfile from Task 3; only the control-plane importer section changes.

- [ ] **Step 2: Write the failing session-codec tests**

Append to `apps/control-plane/src/auth/session.test.ts` (and add `openJson, sealJson` to its import from `./session`):

```ts
describe('sealJson / openJson', () => {
  test('round-trips an arbitrary JSON object with an absolute expiry', () => {
    const token = sealJson({ state: 's', nonce: 'n' }, SECRET, 60_000, 1_000)
    expect(openJson(token, SECRET, 30_000)).toEqual({ state: 's', nonce: 'n', exp: 61_000 })
  })

  test('returns null once expired, when tampered, or under another secret', () => {
    const token = sealJson({ a: 1 }, SECRET, 60_000, 0)
    expect(openJson(token, SECRET, 60_000)).toBeNull()
    expect(openJson(token, 'another-secret-entirely', 1)).toBeNull()
    const [, sig] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ a: 2, exp: 9e15 })).toString('base64url')
    expect(openJson(`${forged}.${sig}`, SECRET, 1)).toBeNull()
    expect(openJson('garbage', SECRET, 1)).toBeNull()
  })

  test('session tokens are byte-compatible with the previous codec', () => {
    const token = signSession(base, SECRET, 60_000, 1_000)
    const [body] = token.split('.')
    expect(JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))).toEqual({ uid: 'u1', oid: 'o1', role: 'admin', exp: 61_000 })
  })
})
```

- [ ] **Step 3: Write the failing OIDC client tests**

Create `apps/control-plane/src/auth/oidc-client.test.ts`:

```ts
import { afterEach, describe, expect, test } from 'vitest'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { CONSOLE_CLIENT_ID } from '@metamodels/schema'
import {
  codeChallenge, loadOidcClientConfig, newTransaction, OidcClient, onOrigin, type OidcClientConfig,
} from './oidc-client'

const SUB = '00000000-0000-4000-8000-000000000001'
const SECRET = 'console-secret-0123456789'
const TX = { state: 'st', nonce: 'expected-nonce', codeVerifier: 'v'.repeat(43) }

/** A minimal OP: discovery, JWKS and a token endpoint that mints a real RS256 ID token. */
interface StubOp {
  port: number
  issuer: string
  discoveryCount: number
  tokenRequests: Array<{ host: string; authorization: string; body: URLSearchParams }>
  idTokenClaims: Record<string, unknown>
  audience: string
  tokenStatus: number
  discoveryIssuer?: string
  close(): Promise<void>
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function startStubOp(): Promise<StubOp> {
  const { privateKey, publicKey } = await generateKeyPair('RS256')
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
  const op = {
    port: 0, issuer: '', discoveryCount: 0, tokenRequests: [], idTokenClaims: {},
    audience: CONSOLE_CLIENT_ID, tokenStatus: 200,
  } as unknown as StubOp
  const server = createServer(async (req, res) => {
    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }
    const path = (req.url ?? '/').split('?')[0]
    if (path === '/.well-known/openid-configuration') {
      op.discoveryCount += 1
      // Like oidc-provider (OIDCContext#urlFor resolves against the request URL), endpoints are
      // built from the Host the request arrived on, not from the issuer.
      const base = `http://${req.headers.host}`
      return json(200, {
        issuer: op.discoveryIssuer ?? op.issuer,
        authorization_endpoint: `${base}/auth`,
        token_endpoint: `${base}/token`,
        jwks_uri: `${base}/jwks`,
        end_session_endpoint: `${base}/session/end`,
      })
    }
    if (path === '/jwks') return json(200, { keys: [jwk] })
    if (path === '/token' && req.method === 'POST') {
      op.tokenRequests.push({ host: req.headers.host ?? '', authorization: req.headers.authorization ?? '', body: new URLSearchParams(await body(req)) })
      if (op.tokenStatus !== 200) return json(op.tokenStatus, { error: 'invalid_grant' })
      const idToken = await new SignJWT({ nonce: 'expected-nonce', ...op.idTokenClaims })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(op.issuer).setAudience(op.audience).setSubject(SUB)
        .setIssuedAt().setExpirationTime('5m')
        .sign(privateKey)
      return json(200, { access_token: 'opaque', token_type: 'Bearer', id_token: idToken })
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  op.port = (server.address() as AddressInfo).port
  op.issuer = `http://127.0.0.1:${op.port}`
  op.close = () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) })
  return op
}

let op: StubOp | undefined
afterEach(async () => { await op?.close(); op = undefined })

function cfg(o: StubOp, over: Partial<OidcClientConfig> = {}): OidcClientConfig {
  return { issuer: o.issuer, internalUrl: o.issuer, consoleUrl: 'https://console.example.test', clientSecret: SECRET, ...over }
}

describe('configuration and primitives', () => {
  test('loadOidcClientConfig normalises origins and defaults the back channel to the issuer', () => {
    const c = loadOidcClientConfig({
      OIDC_ISSUER: 'https://auth.example.test/', CONSOLE_URL: 'https://console.example.test', CONSOLE_CLIENT_SECRET: SECRET,
    })
    expect(c).toEqual({
      issuer: 'https://auth.example.test', internalUrl: 'https://auth.example.test',
      consoleUrl: 'https://console.example.test', clientSecret: SECRET,
    })
  })

  test('loadOidcClientConfig rejects a missing secret and a URL with a path', () => {
    expect(() => loadOidcClientConfig({ OIDC_ISSUER: 'https://a.test', CONSOLE_URL: 'https://c.test' })).toThrow('CONSOLE_CLIENT_SECRET')
    expect(() => loadOidcClientConfig({ OIDC_ISSUER: 'https://a.test/x', CONSOLE_URL: 'https://c.test', CONSOLE_CLIENT_SECRET: SECRET })).toThrow('OIDC_ISSUER must be an origin')
  })

  test('codeChallenge matches the RFC 7636 appendix B vector', () => {
    expect(codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  test('newTransaction yields distinct, high-entropy values', () => {
    const a = newTransaction()
    const b = newTransaction()
    expect(a.state).not.toBe(b.state)
    for (const v of [a.state, a.nonce, a.codeVerifier]) expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  test('onOrigin swaps only the origin', () => {
    expect(onOrigin('https://auth.example.test/token?x=1', 'http://auth:3100')).toBe('http://auth:3100/token?x=1')
  })
})

describe('OidcClient', () => {
  test('builds an authorization URL carrying PKCE, state, nonce and an optional login hint', async () => {
    op = await startStubOp()
    const url = new URL(await new OidcClient(cfg(op)).authorizationUrl(TX, 'me@x.io'))
    expect(url.origin + url.pathname).toBe(`${op.issuer}/auth`)
    const p = url.searchParams
    expect(p.get('client_id')).toBe(CONSOLE_CLIENT_ID)
    expect(p.get('response_type')).toBe('code')
    expect(p.get('scope')).toBe('openid')
    expect(p.get('redirect_uri')).toBe('https://console.example.test/auth/callback')
    expect(p.get('state')).toBe('st')
    expect(p.get('nonce')).toBe('expected-nonce')
    expect(p.get('code_challenge')).toBe(codeChallenge(TX.codeVerifier))
    expect(p.get('code_challenge_method')).toBe('S256')
    expect(p.get('login_hint')).toBe('me@x.io')
  })

  test('exchanges a code with client_secret_basic and returns the verified subject', async () => {
    op = await startStubOp()
    expect(await new OidcClient(cfg(op)).exchangeCode('the-code', TX)).toEqual({ sub: SUB })
    const req = op.tokenRequests[0]
    expect(Buffer.from(req.authorization.replace('Basic ', ''), 'base64').toString()).toBe(`${CONSOLE_CLIENT_ID}:${SECRET}`)
    expect(Object.fromEntries(req.body)).toEqual({
      grant_type: 'authorization_code', code: 'the-code',
      redirect_uri: 'https://console.example.test/auth/callback', code_verifier: TX.codeVerifier,
    })
  })

  test('calls the OP through the back channel, but sends browsers to the public issuer', async () => {
    op = await startStubOp()
    const internal = op.issuer                    // what the console can actually reach
    op.issuer = `http://localhost:${op.port}`     // what the OP advertises and signs as `iss`
    const client = new OidcClient(cfg(op, { issuer: op.issuer, internalUrl: internal }))
    // Discovery came over the back channel, so the OP named the internal host in its endpoints.
    // A browser sent there would fail (in Docker: http://auth:3100 is unresolvable outside).
    expect(new URL(await client.authorizationUrl(TX)).origin).toBe(op.issuer)
    expect(new URL(await client.endSessionUrl()).origin).toBe(op.issuer)
    expect(await client.exchangeCode('c', TX)).toEqual({ sub: SUB })
    expect(op.tokenRequests[0].host).toBe(`127.0.0.1:${op.port}`)
  })

  test('rejects an ID token with the wrong nonce', async () => {
    op = await startStubOp()
    op.idTokenClaims = { nonce: 'someone-elses-nonce' }
    await expect(new OidcClient(cfg(op)).exchangeCode('c', TX)).rejects.toThrow('nonce mismatch')
  })

  test('rejects an ID token issued for another client', async () => {
    op = await startStubOp()
    op.audience = 'some-other-client'
    await expect(new OidcClient(cfg(op)).exchangeCode('c', TX)).rejects.toThrow()
  })

  test('surfaces a token-endpoint error', async () => {
    op = await startStubOp()
    op.tokenStatus = 400
    await expect(new OidcClient(cfg(op)).exchangeCode('c', TX)).rejects.toThrow('token exchange failed: invalid_grant')
  })

  test('refuses a discovery document for a different issuer', async () => {
    op = await startStubOp()
    op.discoveryIssuer = 'https://impostor.example.test'
    await expect(new OidcClient(cfg(op)).metadata()).rejects.toThrow('issuer mismatch')
  })

  test('caches discovery for five minutes', async () => {
    op = await startStubOp()
    let now = 0
    const client = new OidcClient(cfg(op), () => now)
    await client.metadata()
    await client.metadata()
    expect(op.discoveryCount).toBe(1)
    now += 5 * 60 * 1000
    await client.metadata()
    expect(op.discoveryCount).toBe(2)
  })

  test('builds the RP-initiated logout URL back to the console login', async () => {
    op = await startStubOp()
    const url = new URL(await new OidcClient(cfg(op)).endSessionUrl())
    expect(url.origin + url.pathname).toBe(`${op.issuer}/session/end`)
    expect(url.searchParams.get('client_id')).toBe(CONSOLE_CLIENT_ID)
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('https://console.example.test/login')
  })
})
```

- [ ] **Step 4: Run them to verify they fail**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/auth/session.test.ts src/auth/oidc-client.test.ts`
Expected: FAIL — `sealJson`/`openJson` are not exported, and `./oidc-client` cannot be resolved.

- [ ] **Step 5: Generalise the session codec**

In `apps/control-plane/src/auth/session.ts`, keep `SessionPayload` and the private `sign()` helper, and replace `signSession` and `verifySession` with:

```ts
/** Seal any JSON object with an absolute expiry: `base64url(json).base64url(hmac-sha256)`. */
export function sealJson(payload: Record<string, unknown>, secret: string, ttlMs: number, nowMs: number): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: nowMs + ttlMs })).toString('base64url')
  return `${body}.${sign(body, secret)}`
}

/** Open a sealJson token. Null on a bad signature, a malformed body, or a missing or elapsed expiry. */
export function openJson(token: string, secret: string, nowMs: number): Record<string, unknown> | null {
  const dot = token.indexOf('.')
  if (dot <= 0) return null
  const body = token.slice(0, dot)
  const sigBuf = Buffer.from(token.slice(dot + 1))
  const expBuf = Buffer.from(sign(body, secret))
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const p = parsed as Record<string, unknown>
  if (typeof p.exp !== 'number' || nowMs >= p.exp) return null
  return p
}

export function signSession(
  payload: Omit<SessionPayload, 'exp'>,
  secret: string,
  ttlMs: number,
  nowMs: number,
): string {
  return sealJson({ uid: payload.uid, oid: payload.oid, role: payload.role }, secret, ttlMs, nowMs)
}

export function verifySession(token: string, secret: string, nowMs: number): SessionPayload | null {
  const p = openJson(token, secret, nowMs)
  if (!p) return null
  if (typeof p.uid !== 'string' || typeof p.oid !== 'string' || !isRole(p.role)) return null
  return { uid: p.uid, oid: p.oid, role: p.role as Role, exp: p.exp as number }
}
```

- [ ] **Step 6: Implement the OIDC client**

Create `apps/control-plane/src/auth/oidc-client.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto'
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { CONSOLE_CLIENT_ID } from '@metamodels/schema'

const METADATA_TTL_MS = 5 * 60 * 1000
const TIMEOUT_MS = 10_000

export interface OidcClientConfig {
  /** Public issuer: where browsers are sent, and what `iss` must equal. */
  issuer: string
  /** Where this server reaches the OP. Equals `issuer` unless the OP is on a private network hop. */
  internalUrl: string
  /** Public console origin. Redirect and post-logout URIs derive from it. */
  consoleUrl: string
  clientSecret: string
}

export interface AuthTransaction {
  state: string
  nonce: string
  codeVerifier: string
}

export interface OidcMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  end_session_endpoint: string
}

export class OidcError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OidcError'
  }
}

type Env = Record<string, string | undefined>

function originOf(name: string, value: string | undefined): string {
  if (!value?.trim()) throw new OidcError(`${name} is required`)
  let u: URL
  try {
    u = new URL(value)
  } catch {
    throw new OidcError(`${name} must be an absolute http(s) URL`)
  }
  if (u.pathname !== '/' || u.search || u.hash) throw new OidcError(`${name} must be an origin (no path, query or fragment)`)
  return u.origin
}

export function loadOidcClientConfig(env: Env = {
  OIDC_ISSUER: process.env.OIDC_ISSUER,
  OIDC_INTERNAL_URL: process.env.OIDC_INTERNAL_URL,
  CONSOLE_URL: process.env.CONSOLE_URL,
  CONSOLE_CLIENT_SECRET: process.env.CONSOLE_CLIENT_SECRET,
}): OidcClientConfig {
  const issuer = originOf('OIDC_ISSUER', env.OIDC_ISSUER)
  const clientSecret = env.CONSOLE_CLIENT_SECRET ?? ''
  if (clientSecret.length < 16) throw new OidcError('CONSOLE_CLIENT_SECRET must be set (>=16 chars)')
  return {
    issuer,
    internalUrl: env.OIDC_INTERNAL_URL?.trim() ? originOf('OIDC_INTERNAL_URL', env.OIDC_INTERNAL_URL) : issuer,
    consoleUrl: originOf('CONSOLE_URL', env.CONSOLE_URL),
    clientSecret,
  }
}

export function newTransaction(): AuthTransaction {
  const random = () => randomBytes(32).toString('base64url')
  return { state: random(), nonce: random(), codeVerifier: random() }
}

export function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

/** The same URL on another origin — path and query kept, scheme and host replaced. */
export function onOrigin(url: string, origin: string): string {
  const u = new URL(url)
  const target = new URL(origin)
  u.protocol = target.protocol
  u.host = target.host
  return u.href
}

export class OidcClient {
  private meta?: { value: OidcMetadata; fetchedAt: number }
  private jwks?: JWTVerifyGetKey

  constructor(readonly cfg: OidcClientConfig, private readonly now: () => number = Date.now) {}

  get redirectUri(): string {
    return `${this.cfg.consoleUrl}/auth/callback`
  }

  get postLogoutRedirectUri(): string {
    return `${this.cfg.consoleUrl}/login`
  }

  async metadata(): Promise<OidcMetadata> {
    if (this.meta && this.now() - this.meta.fetchedAt < METADATA_TTL_MS) return this.meta.value
    const res = await fetch(`${this.cfg.internalUrl}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) throw new OidcError(`discovery failed: HTTP ${res.status}`)
    const m = (await res.json()) as Partial<OidcMetadata>
    if (m.issuer !== this.cfg.issuer) throw new OidcError(`issuer mismatch: expected ${this.cfg.issuer}, got ${String(m.issuer)}`)
    for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'end_session_endpoint'] as const) {
      if (typeof m[key] !== 'string') throw new OidcError(`discovery document lacks ${key}`)
    }
    // oidc-provider builds endpoint URLs from the request's own host (OIDCContext#urlFor resolves
    // against ctx.href), so a document fetched over the back channel names the internal host.
    // Re-home every endpoint explicitly: browser-facing ones onto the public issuer here,
    // server-to-server ones onto the back channel where they are called.
    const doc = m as OidcMetadata
    const value: OidcMetadata = {
      ...doc,
      authorization_endpoint: onOrigin(doc.authorization_endpoint, this.cfg.issuer),
      end_session_endpoint: onOrigin(doc.end_session_endpoint, this.cfg.issuer),
    }
    this.meta = { value, fetchedAt: this.now() }
    return this.meta.value
  }

  async authorizationUrl(tx: AuthTransaction, loginHint?: string): Promise<string> {
    const url = new URL((await this.metadata()).authorization_endpoint)
    url.search = new URLSearchParams({
      client_id: CONSOLE_CLIENT_ID,
      response_type: 'code',
      scope: 'openid',
      redirect_uri: this.redirectUri,
      state: tx.state,
      nonce: tx.nonce,
      code_challenge: codeChallenge(tx.codeVerifier),
      code_challenge_method: 'S256',
      ...(loginHint ? { login_hint: loginHint } : {}),
    }).toString()
    return url.href
  }

  /** Back-channel code exchange, then ID-token verification. Returns the subject (the user id). */
  async exchangeCode(code: string, tx: AuthTransaction): Promise<{ sub: string }> {
    const meta = await this.metadata()
    const basic = Buffer.from(`${encodeURIComponent(CONSOLE_CLIENT_ID)}:${encodeURIComponent(this.cfg.clientSecret)}`).toString('base64')
    const res = await fetch(onOrigin(meta.token_endpoint, this.cfg.internalUrl), {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: this.redirectUri, code_verifier: tx.codeVerifier,
      }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const json = (await res.json().catch(() => ({}))) as { id_token?: unknown; error?: unknown }
    if (!res.ok || typeof json.id_token !== 'string') {
      throw new OidcError(`token exchange failed: ${String(json.error ?? `HTTP ${res.status}`)}`)
    }

    this.jwks ??= createRemoteJWKSet(new URL(onOrigin(meta.jwks_uri, this.cfg.internalUrl)))
    const { payload } = await jwtVerify(json.id_token, this.jwks, {
      issuer: this.cfg.issuer, audience: CONSOLE_CLIENT_ID, algorithms: ['RS256'],
    })
    if (payload.nonce !== tx.nonce) throw new OidcError('ID token nonce mismatch')
    if (typeof payload.sub !== 'string' || payload.sub === '') throw new OidcError('ID token has no subject')
    return { sub: payload.sub }
  }

  async endSessionUrl(): Promise<string> {
    const url = new URL((await this.metadata()).end_session_endpoint)
    url.search = new URLSearchParams({ client_id: CONSOLE_CLIENT_ID, post_logout_redirect_uri: this.postLogoutRedirectUri }).toString()
    return url.href
  }
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/auth/session.test.ts src/auth/oidc-client.test.ts`
Expected: PASS — 8 session tests (5 existing + 3 new) and 14 client tests.

Run: `pnpm exec vitest run packages/schema/test/env-example.test.ts`
Expected: PASS — the four `process.env` keys the client reads were documented in Task 9.

- [ ] **Step 8: Type-check and commit**

Run: `pnpm --filter @metamodels/control-plane build`
Expected: exit 0.

```bash
git add apps/control-plane/src/auth apps/control-plane/package.json pnpm-lock.yaml
git commit -m "feat(control-plane): OIDC relying-party client and generic sealed cookies"
```

---

### Task 11: Cut the console over to the auth service

The commit that removes password login from the console. After it, a console session is only ever minted from an ID token the OP signed. **Tasks 11 and 12 must land in the same PR:** after this task the console needs the auth service, and Task 12 is what adds it to the compose stacks CI smokes.

**Files:**
- Create: `apps/control-plane/src/server/actor.ts`, `apps/control-plane/src/server/actor.test.ts`
- Create: `apps/control-plane/src/server/sign-in.ts`, `apps/control-plane/src/server/sign-in.test.ts`
- Create: `apps/control-plane/src/server/oidc-session.ts`
- Create: `apps/control-plane/src/server/license-on-login.ts`
- Create: `apps/control-plane/src/app/login/route.ts`
- Create: `apps/control-plane/src/app/auth/callback/route.ts`
- Create: `apps/control-plane/src/app/auth/error/page.tsx`
- Modify: `apps/control-plane/src/server/current-user.ts`
- Modify: `apps/control-plane/src/app/login/actions.ts` (logout only)
- Modify: `apps/control-plane/src/app/accept-invite/actions.ts`
- Modify: `apps/control-plane/src/lib/csp.ts`, `apps/control-plane/src/lib/csp.test.ts`, `apps/control-plane/src/middleware.ts`
- Delete: `apps/control-plane/src/app/login/page.tsx`, `apps/control-plane/src/server/auth-service.ts`, `apps/control-plane/src/server/auth-service.test.ts`, `apps/control-plane/src/auth/login-throttle.ts`, `apps/control-plane/src/auth/login-throttle.test.ts`

**Interfaces:**
- Consumes: `OidcClient`, `loadOidcClientConfig`, `newTransaction`, `AuthTransaction` (Task 10); `sealJson`, `openJson` (Task 10); `setSessionCookie`, `clearSessionCookie` (existing).
- Produces:
  - `loadActiveActor(db: Db, uid: string): Promise<Actor | null>` — the single place a user row becomes an `Actor`
  - `type SignInFailure = 'access_denied' | 'provider_error' | 'state_mismatch' | 'issuer_mismatch' | 'missing_code' | 'token_exchange_failed' | 'account_unavailable'`
  - `completeSignIn(params: URLSearchParams, tx: AuthTransaction | null, deps: SignInDeps): Promise<SignInResult>`
  - `getOidcClient(): OidcClient`, `setTransactionCookie(tx)`, `takeTransactionCookie()`, `TX_COOKIE = 'mm_oidc_tx'`
  - `revalidateLicenseOnLogin(orgId: string): Promise<void>`
  - `sessionSecret(): string` (exported from `current-user.ts`)
  - `buildCsp(nonce, { dev, formActionOrigins? })`, `originOf(url?: string): string | undefined`
  - Routes: `GET /login` → 303 to the OP; `GET /auth/callback` → 303 to `/` or `/auth/error?reason=…`; page `/auth/error`

- [ ] **Step 1: Write the failing tests**

Create `apps/control-plane/src/server/actor.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import * as schema from '@metamodels/schema'
import { freshDb, seedOrg } from '../test/db'
import { loadActiveActor } from './actor'

async function withUser(overrides: Partial<{ status: string; role: string }> = {}) {
  const db = await freshDb()
  const org = await seedOrg(db)
  const [u] = await db.insert(schema.user).values({
    orgId: org.id, email: 'op@x.io', passwordHash: 'unused', role: overrides.role ?? 'member', status: overrides.status ?? 'active',
  }).returning()
  return { db, u, org }
}

describe('loadActiveActor', () => {
  test('maps an active user to an Actor', async () => {
    const { db, u, org } = await withUser()
    expect(await loadActiveActor(db, u.id)).toEqual({ id: u.id, orgId: org.id, email: 'op@x.io', role: 'member' })
  })

  test('refuses a deactivated user or an unknown role', async () => {
    const off = await withUser({ status: 'deactivated' })
    expect(await loadActiveActor(off.db, off.u.id)).toBeNull()
    const odd = await withUser({ role: 'owner' })
    expect(await loadActiveActor(odd.db, odd.u.id)).toBeNull()
  })

  test('refuses an unknown id and a non-uuid id without a database error', async () => {
    const { db } = await withUser()
    expect(await loadActiveActor(db, '00000000-0000-4000-8000-000000000000')).toBeNull()
    expect(await loadActiveActor(db, 'not-a-uuid')).toBeNull()
  })
})
```

Create `apps/control-plane/src/server/sign-in.test.ts`:

```ts
import { describe, expect, test, vi } from 'vitest'
import type { Actor } from '../auth/authorize'
import { completeSignIn, type SignInDeps } from './sign-in'

const ISSUER = 'https://auth.example.test'
const TX = { state: 'st-1', nonce: 'n-1', codeVerifier: 'v'.repeat(43) }
const ACTOR: Actor = { id: 'u-1', orgId: 'o-1', email: 'op@x.io', role: 'admin' }

function deps(over: Partial<SignInDeps> = {}): SignInDeps {
  return {
    issuer: ISSUER,
    exchangeCode: vi.fn(async () => ({ sub: 'u-1' })),
    loadActor: vi.fn(async () => ACTOR),
    ...over,
  }
}

const ok = (extra: Record<string, string> = {}) =>
  new URLSearchParams({ code: 'c-1', state: 'st-1', iss: ISSUER, ...extra })

describe('completeSignIn', () => {
  test('a valid callback resolves to the Actor', async () => {
    const d = deps()
    expect(await completeSignIn(ok(), TX, d)).toEqual({ ok: true, actor: ACTOR })
    expect(d.exchangeCode).toHaveBeenCalledWith('c-1', TX)
    expect(d.loadActor).toHaveBeenCalledWith('u-1')
  })

  test('an OP error is reported, with only access_denied passed through by name', async () => {
    expect(await completeSignIn(new URLSearchParams({ error: 'access_denied', state: 'st-1' }), TX, deps()))
      .toEqual({ ok: false, reason: 'access_denied' })
    expect(await completeSignIn(new URLSearchParams({ error: 'server_error', state: 'st-1' }), TX, deps()))
      .toEqual({ ok: false, reason: 'provider_error' })
  })

  test('a missing transaction or a mismatched state stops before any token request', async () => {
    const d = deps()
    expect(await completeSignIn(ok(), null, d)).toEqual({ ok: false, reason: 'state_mismatch' })
    expect(await completeSignIn(ok({ state: 'forged' }), TX, d)).toEqual({ ok: false, reason: 'state_mismatch' })
    expect(d.exchangeCode).not.toHaveBeenCalled()
  })

  test('RFC 9207: a missing or foreign iss is rejected (the OP always sends it)', async () => {
    const missing = ok()
    missing.delete('iss')
    expect(await completeSignIn(missing, TX, deps())).toEqual({ ok: false, reason: 'issuer_mismatch' })
    expect(await completeSignIn(ok({ iss: 'https://impostor.test' }), TX, deps())).toEqual({ ok: false, reason: 'issuer_mismatch' })
  })

  test('a callback without a code is rejected', async () => {
    const p = ok()
    p.delete('code')
    expect(await completeSignIn(p, TX, deps())).toEqual({ ok: false, reason: 'missing_code' })
  })

  test('a failed token exchange is reported without leaking the error', async () => {
    const d = deps({ exchangeCode: vi.fn(async () => { throw new Error('secret detail') }) })
    expect(await completeSignIn(ok(), TX, d)).toEqual({ ok: false, reason: 'token_exchange_failed' })
  })

  test('a subject with no active account is refused', async () => {
    expect(await completeSignIn(ok(), TX, deps({ loadActor: vi.fn(async () => null) })))
      .toEqual({ ok: false, reason: 'account_unavailable' })
  })
})
```

Append to `apps/control-plane/src/lib/csp.test.ts` (inside the `describe('buildCsp', …)` block, and add `originOf` to its import):

```ts
  it('lets forms redirect to the auth service origin, and nowhere else', () => {
    const d = parse(buildCsp('abc123', { dev: false, formActionOrigins: ['https://auth.example.test'] }))
    expect(d['form-action']).toEqual(["'self'", 'https://auth.example.test'])
  })

  it('originOf reduces a URL to its origin and tolerates junk', () => {
    expect(originOf('https://auth.example.test/some/path')).toBe('https://auth.example.test')
    expect(originOf(undefined)).toBeUndefined()
    expect(originOf('not a url')).toBeUndefined()
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/actor.test.ts src/server/sign-in.test.ts src/lib/csp.test.ts`
Expected: FAIL — `./actor` and `./sign-in` cannot be resolved; `originOf` is not exported.

- [ ] **Step 3: Implement the pure pieces**

Create `apps/control-plane/src/server/actor.ts`:

```ts
import { eq } from 'drizzle-orm'
import { user } from '@metamodels/schema'
import { isRole, type Actor } from '../auth/authorize'
import type { Db } from './db'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The Actor for an active user, or null. The single place a user row becomes an Actor — used on
 * every request (session cookie) and at sign-in (ID-token subject), so deactivation or a role
 * change takes effect immediately on both paths.
 */
export async function loadActiveActor(db: Db, uid: string): Promise<Actor | null> {
  if (!UUID.test(uid)) return null
  const rows = await db.select().from(user).where(eq(user.id, uid)).limit(1)
  const u = rows[0]
  if (!u || u.status !== 'active' || !isRole(u.role)) return null
  return { id: u.id, orgId: u.orgId, email: u.email, role: u.role }
}
```

Create `apps/control-plane/src/server/sign-in.ts`:

```ts
import type { Actor } from '../auth/authorize'
import type { AuthTransaction } from '../auth/oidc-client'

export type SignInFailure =
  | 'access_denied'
  | 'provider_error'
  | 'state_mismatch'
  | 'issuer_mismatch'
  | 'missing_code'
  | 'token_exchange_failed'
  | 'account_unavailable'

export type SignInResult = { ok: true; actor: Actor } | { ok: false; reason: SignInFailure }

export interface SignInDeps {
  issuer: string
  exchangeCode(code: string, tx: AuthTransaction): Promise<{ sub: string }>
  loadActor(sub: string): Promise<Actor | null>
}

/**
 * Validate the OP's redirect to /auth/callback and resolve it to an Actor. Pure — no cookies, no
 * Next — so every rejection path is unit-tested. Order matters: nothing reaches the token endpoint
 * until state and issuer have both checked out.
 */
export async function completeSignIn(
  params: URLSearchParams, tx: AuthTransaction | null, deps: SignInDeps,
): Promise<SignInResult> {
  const error = params.get('error')
  if (error) return { ok: false, reason: error === 'access_denied' ? 'access_denied' : 'provider_error' }
  if (!tx || params.get('state') !== tx.state) return { ok: false, reason: 'state_mismatch' }
  // RFC 9207: our OP advertises authorization_response_iss_parameter_supported, so iss is mandatory.
  if (params.get('iss') !== deps.issuer) return { ok: false, reason: 'issuer_mismatch' }
  const code = params.get('code')
  if (!code) return { ok: false, reason: 'missing_code' }

  let sub: string
  try {
    ;({ sub } = await deps.exchangeCode(code, tx))
  } catch {
    return { ok: false, reason: 'token_exchange_failed' }
  }
  const actor = await deps.loadActor(sub)
  if (!actor) return { ok: false, reason: 'account_unavailable' }
  return { ok: true, actor }
}
```

In `apps/control-plane/src/lib/csp.ts`, extend `CspOptions` and the `form-action` directive, and add `originOf`:

```ts
export interface CspOptions {
  /** Dev server: webpack HMR needs eval + a websocket back to the dev server. */
  dev: boolean
  /**
   * Origins a form submission may redirect to. Sign-out posts to the console and is redirected to
   * the auth service's end-session endpoint; Chrome enforces form-action across that redirect.
   */
  formActionOrigins?: readonly string[]
}

/** The origin of an absolute URL, or undefined for anything unparseable. */
export function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}
```

Change the signature line to `export function buildCsp(nonce: string, { dev, formActionOrigins = [] }: CspOptions): string {` and the directive to:

```ts
    ['form-action', ["'self'", ...formActionOrigins]],
```

In `apps/control-plane/src/middleware.ts`, add `originOf` to the `./lib/csp.js` import and replace the `const csp = …` line with:

```ts
  const authOrigin = originOf(process.env.OIDC_ISSUER)
  const csp = buildCsp(nonce, {
    dev: process.env.NODE_ENV !== 'production',
    formActionOrigins: authOrigin ? [authOrigin] : [],
  })
```

and add `runtime: 'nodejs'` as the first key of the exported `config`:

```ts
export const config = {
  // Node, not edge: OIDC_ISSUER must be read from the container's environment on each request.
  // The published image is built once, with no deployment's values present.
  runtime: 'nodejs',
  matcher: [
```

`OIDC_ISSUER` is read per request, at runtime. Task 13 verifies the header in the running container: a value inlined at `next build` time would silently be empty in the published image.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/actor.test.ts src/server/sign-in.test.ts src/lib/csp.test.ts`
Expected: PASS — 3 actor, 7 sign-in, and the csp suite with 2 new tests.

- [ ] **Step 5: Wire the session helpers**

In `apps/control-plane/src/server/current-user.ts`:
1. Rename the private `secret()` to an exported `sessionSecret()` and update its two call sites.
2. Replace the body of `getCurrentActor` after `if (!payload) return null` with a call to the shared loader:

```ts
export async function getCurrentActor(): Promise<Actor | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  if (!token) return null
  const payload = verifySession(token, sessionSecret(), Date.now())
  if (!payload) return null
  // Re-load the user so a deactivated/role-changed user loses access immediately.
  return loadActiveActor(getDb(), payload.uid)
}
```

and add `import { loadActiveActor } from './actor'`. Remove the now-unused `eq`, `user` and `isRole` imports.

Create `apps/control-plane/src/server/oidc-session.ts`:

```ts
import { cookies } from 'next/headers'
import { loadOidcClientConfig, OidcClient, type AuthTransaction } from '../auth/oidc-client'
import { openJson, sealJson } from '../auth/session'
import { sessionSecret } from './current-user'

export const TX_COOKIE = 'mm_oidc_tx'
const TX_TTL_MS = 10 * 60 * 1000
const TX_PATH = '/auth/callback'

let client: OidcClient | undefined

/** One client per process, so discovery and the JWKS are cached across requests. */
export function getOidcClient(): OidcClient {
  client ??= new OidcClient(loadOidcClientConfig())
  return client
}

export async function setTransactionCookie(tx: AuthTransaction): Promise<void> {
  ;(await cookies()).set(TX_COOKIE, sealJson({ ...tx }, sessionSecret(), TX_TTL_MS, Date.now()), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    // Lax, not Strict: the OP's redirect back is a cross-site top-level GET, which Lax still sends.
    sameSite: 'lax',
    path: TX_PATH,
    maxAge: TX_TTL_MS / 1000,
  })
}

/** Read AND delete the transaction: one attempt per sign-in, never replayable. */
export async function takeTransactionCookie(): Promise<AuthTransaction | null> {
  const jar = await cookies()
  const raw = jar.get(TX_COOKIE)?.value
  jar.delete({ name: TX_COOKIE, path: TX_PATH })
  if (!raw) return null
  const p = openJson(raw, sessionSecret(), Date.now())
  if (!p || typeof p.state !== 'string' || typeof p.nonce !== 'string' || typeof p.codeVerifier !== 'string') return null
  return { state: p.state, nonce: p.nonce, codeVerifier: p.codeVerifier }
}
```

Create `apps/control-plane/src/server/license-on-login.ts` — the block moved verbatim out of the old login action:

```ts
import { getDb } from './db'

/** Best-effort licence re-validation after sign-in. Never throws: sign-in must not fail on licensing. */
export async function revalidateLicenseOnLogin(orgId: string): Promise<void> {
  try {
    if (!process.env.LICENSE_KEY_SECRET) return
    const { revalidateLicense } = await import('./license-service')
    const { LemonSqueezyClient } = await import('./ls-client')
    await revalidateLicense(getDb(), orgId, {
      ls: new LemonSqueezyClient(), secret: process.env.LICENSE_KEY_SECRET, nowMs: Date.now(),
    })
  } catch {
    // ignore — offline grace covers any failure
  }
}
```

- [ ] **Step 6: Replace the login page with the OIDC routes**

```bash
git rm apps/control-plane/src/app/login/page.tsx
```

Create `apps/control-plane/src/app/login/route.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server'
import { newTransaction } from '../../auth/oidc-client'
import { getOidcClient, setTransactionCookie } from '../../server/oidc-session'

export const dynamic = 'force-dynamic'

/** Start sign-in: mint a transaction, seal it into a cookie, send the browser to the OP. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  let target: string
  try {
    const tx = newTransaction()
    target = await getOidcClient().authorizationUrl(tx, req.nextUrl.searchParams.get('login_hint') ?? undefined)
    await setTransactionCookie(tx)
  } catch {
    // OP unreachable or console misconfigured. Show a page — never loop back into /login.
    return NextResponse.redirect(new URL('/auth/error?reason=unavailable', req.url), 303)
  }
  return NextResponse.redirect(target, 303)
}
```

Create `apps/control-plane/src/app/auth/callback/route.ts`:

```ts
import { NextResponse, type NextRequest } from 'next/server'
import { loadActiveActor } from '../../../server/actor'
import { setSessionCookie } from '../../../server/current-user'
import { getDb } from '../../../server/db'
import { revalidateLicenseOnLogin } from '../../../server/license-on-login'
import { getOidcClient, takeTransactionCookie } from '../../../server/oidc-session'
import { completeSignIn } from '../../../server/sign-in'

export const dynamic = 'force-dynamic'

/** The OP's redirect target. Everything that can reject lives in completeSignIn. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const client = getOidcClient()
  const tx = await takeTransactionCookie()
  const result = await completeSignIn(req.nextUrl.searchParams, tx, {
    issuer: client.cfg.issuer,
    exchangeCode: (code, t) => client.exchangeCode(code, t),
    loadActor: (sub) => loadActiveActor(getDb(), sub),
  })
  // Absolute URLs from CONSOLE_URL: behind a proxy or tunnel, req.url is the container's own address.
  if (!result.ok) {
    return NextResponse.redirect(new URL(`/auth/error?reason=${result.reason}`, client.cfg.consoleUrl), 303)
  }
  await setSessionCookie(result.actor)
  await revalidateLicenseOnLogin(result.actor.orgId)
  return NextResponse.redirect(new URL('/', client.cfg.consoleUrl), 303)
}
```

Create `apps/control-plane/src/app/auth/error/page.tsx`:

```tsx
const MESSAGES: Record<string, string> = {
  unavailable: 'The sign-in service is not reachable. Check that the auth service is running.',
  access_denied: 'Sign-in was cancelled or refused.',
  provider_error: 'The sign-in service reported an error.',
  state_mismatch: 'This sign-in attempt expired, or was started in another tab.',
  issuer_mismatch: 'The sign-in response came from an unexpected issuer.',
  missing_code: 'The sign-in response was incomplete.',
  token_exchange_failed: 'The console could not complete sign-in with the auth service.',
  account_unavailable: 'This account is deactivated or no longer exists.',
}

export default async function SignInErrorPage({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  const { reason } = await searchParams
  const message = reason && Object.hasOwn(MESSAGES, reason) ? MESSAGES[reason] : 'Sign-in could not be completed.'
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-[360px] rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-panel)] p-6">
        <div className="mb-6 font-mono text-lg font-semibold text-[var(--color-primary)]">MetaModels</div>
        <p className="mb-4 text-sm">{message}</p>
        {/* A plain anchor, not <Link>: /login is a route handler that redirects off-origin. */}
        <a href="/login" className="text-sm text-[var(--color-primary)] hover:underline">Try again</a>
      </div>
    </div>
  )
}
```

Replace the whole of `apps/control-plane/src/app/login/actions.ts` with:

```ts
'use server'
import { redirect } from 'next/navigation'
import { clearSessionCookie } from '../../server/current-user'
import { getOidcClient } from '../../server/oidc-session'

/** Sign out of the console, then end the OP session too (RP-initiated logout). */
export async function logout(): Promise<void> {
  await clearSessionCookie()
  let target = '/login'
  try {
    target = await getOidcClient().endSessionUrl()
  } catch {
    // OP unreachable: the console session is already gone, and /login will report the outage.
  }
  redirect(target)
}
```

In `apps/control-plane/src/app/accept-invite/actions.ts`, remove the `setSessionCookie` import and replace the last two statements (`await setSessionCookie(actor)` and `redirect('/')`) with:

```ts
  // Console sessions are only minted from a verified ID token now: send the new user through the
  // OP to sign in with the password they just set, email pre-filled.
  redirect(`/login?login_hint=${encodeURIComponent(actor.email)}`)
```

- [ ] **Step 7: Delete the console's password-login code**

```bash
git rm apps/control-plane/src/server/auth-service.ts apps/control-plane/src/server/auth-service.test.ts \
       apps/control-plane/src/auth/login-throttle.ts apps/control-plane/src/auth/login-throttle.test.ts
```

Run: `grep -rnE "verifyLogin|LoginThrottle|auth-service|DUMMY_PASSWORD_HASH|login/page" apps/control-plane/src apps/control-plane/bin || echo "clean"`
Expected: `clean`.

- [ ] **Step 8: Run every lane and the build**

Run: `pnpm --filter @metamodels/control-plane exec vitest run`
Expected: PASS — the whole control-plane lane, including the new actor, sign-in, oidc-client and csp tests.

Run: `pnpm test`
Expected: PASS — root lane, including `packages/schema/test/env-example.test.ts`.

Run: `pnpm --filter @metamodels/control-plane build`
Expected: exit 0, and the route table printed by `next build` lists `ƒ /login`, `ƒ /auth/callback` and `ƒ /auth/error` as dynamic.

- [ ] **Step 9: Commit**

```bash
git add -A apps/control-plane
git commit -m "feat(control-plane)!: sign in through the auth service

The console no longer handles passwords. /login redirects to the OpenID
Provider; /auth/callback verifies the ID token and mints the existing local
session. Invite acceptance now routes the new user through the OP."
```

---

### Task 12: Run the auth service in every stack

**Land in the same PR as Task 11.** After Task 11 the console cannot sign anyone in without the auth service. **Tag `v0.4.0` from `main` right after the PR merges**: this task moves the Portainer stack's default `TAG` to `0.4.0`. Staying on `0.3.0` would pair the old password-login console with a runtime image that has no `apps/auth`, so the new `auth` service would crash-loop and the console, which waits for it, would never start.

**Files:**
- Modify: `docker-compose.yml`, `docker-compose.deploy.yml`, `docker-compose.portainer.yml`
- Modify: `.dockerignore`
- Modify: `scripts/smoke.sh`, `scripts/new-stack.sh` (both replaced whole)
- Modify: `docs/DEPLOY.md`

**Interfaces:**
- Consumes: `pnpm start` in `apps/auth` (Task 3); `GET /healthz` (Task 7); every env key in the `.env.example` auth block (Task 9); console `GET /login` → 303 to the OP (Task 11).
- Produces: a compose service named `auth` in all three stacks, listening on container port 3100. The console reaches it at `http://auth:3100`. `smoke.sh` gains `SMOKE_PROJECT` (default `metamodels-smoke`), takes its probe ports from `ENV_FILE`, and checks the sign-in hand-off. `.env.verify` is the throwaway env file Task 13 reuses.

- [ ] **Step 1: Watch the checks fail**

Run: `docker compose --env-file .env.example config --services | grep -x auth`
Expected: no output, exit 1.

Run: `bash scripts/new-stack.sh | grep -c '^OIDC_SIGNING_KEY='`
Expected: `0`.

- [ ] **Step 2: The development stack (`docker-compose.yml`)**

In the `control-plane` service's `environment`, add after `LICENSE_KEY_SECRET: ${LICENSE_KEY_SECRET}`:

```yaml
      # Sign-in: browsers go to OIDC_ISSUER; this container talks to the OP over the compose network.
      OIDC_ISSUER: ${OIDC_ISSUER}
      OIDC_INTERNAL_URL: ${OIDC_INTERNAL_URL:-http://auth:3100}
      CONSOLE_URL: ${CONSOLE_URL}
      CONSOLE_CLIENT_SECRET: ${CONSOLE_CLIENT_SECRET}
```

and in its `depends_on`, after the `migrate` entry:

```yaml
      auth:
        condition: service_healthy
```

Then add a new service between `control-plane` and `data-plane`:

```yaml
  # The sign-in service (OpenID Provider, apps/auth). The console redirects browsers here, so
  # its host port must be reachable from the browser at exactly OIDC_ISSUER.
  auth:
    build:
      context: .
      dockerfile: docker/Dockerfile
      target: tsx-app
      args:
        APP: auth
    environment:
      DATABASE_URL: ${DATABASE_URL}
      OIDC_ISSUER: ${OIDC_ISSUER}
      CONSOLE_URL: ${CONSOLE_URL}
      CONSOLE_CLIENT_SECRET: ${CONSOLE_CLIENT_SECRET}
      OIDC_COOKIE_KEYS: ${OIDC_COOKIE_KEYS}
      OIDC_SIGNING_KEY: ${OIDC_SIGNING_KEY}
      OIDC_ALLOW_EPHEMERAL_KEY: ${OIDC_ALLOW_EPHEMERAL_KEY:-false}
      # Pinned like the data-plane's PORT: the healthcheck below hardcodes 3100. Move the host side.
      AUTH_PORT: 3100
    ports:
      - "${AUTH_HOST_PORT:-3100}:3100"
    depends_on:
      postgres:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3100/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 5
```

- [ ] **Step 3: The GHCR stack (`docker-compose.deploy.yml`)**

Replace the two header comment lines with:

```yaml
# Portainer deploy stack: pulls pre-built GHCR images. Set stack env (DATABASE_URL, REDIS_URL,
# SESSION_SECRET, LICENSE_KEY_SECRET, OPERATOR_EMAIL, OPERATOR_PASSWORD, OIDC_ISSUER, CONSOLE_URL,
# CONSOLE_CLIENT_SECRET, OIDC_COOKIE_KEYS, OIDC_SIGNING_KEY) and TAG in Portainer.
```

In the `control-plane` service's `environment`, add after `LICENSE_KEY_SECRET: ${LICENSE_KEY_SECRET}`:

```yaml
      OIDC_ISSUER: ${OIDC_ISSUER}
      OIDC_INTERNAL_URL: http://auth:3100
      CONSOLE_URL: ${CONSOLE_URL}
      CONSOLE_CLIENT_SECRET: ${CONSOLE_CLIENT_SECRET}
```

and in its `depends_on`, after the `migrate` entry:

```yaml
      auth:
        condition: service_healthy
```

Then add a new service between `control-plane` and `data-plane`:

```yaml
  auth:
    image: ghcr.io/carmelosantana/metamodels-runtime:${TAG:-latest}
    restart: unless-stopped
    working_dir: /app/apps/auth
    command: ["pnpm", "start"]
    environment:
      DATABASE_URL: ${DATABASE_URL}
      OIDC_ISSUER: ${OIDC_ISSUER}
      CONSOLE_URL: ${CONSOLE_URL}
      CONSOLE_CLIENT_SECRET: ${CONSOLE_CLIENT_SECRET}
      OIDC_COOKIE_KEYS: ${OIDC_COOKIE_KEYS}
      OIDC_SIGNING_KEY: ${OIDC_SIGNING_KEY}
      # Never ephemeral in a deployed stack: every token and sign-in would die with the container.
      OIDC_ALLOW_EPHEMERAL_KEY: "false"
      AUTH_PORT: 3100
    ports:
      - "${AUTH_HOST_PORT:-3100}:3100"
    depends_on:
      postgres:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3100/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 5
```

- [ ] **Step 4: The drop-in Portainer stack (`docker-compose.portainer.yml`)**

In the header comment, replace `set the four` with `set the seven` (line 3), and `The four secrets use` with `The seven secrets use` (line 13). Below the control-plane bullet (after line 17), add:

```yaml
#   * The auth service (sign-in) is admin-side too: loopback by default. The console sends
#     browsers to it, so an operator forwards BOTH ports (see docs/DEPLOY.md).
```

Replace every `${TAG:-0.3.0}` with `${TAG:-0.4.0}` (six occurrences today, seven once `auth` is added).

In the `control-plane` service's `environment`, add after the `LICENSE_KEY_SECRET` line:

```yaml
      OIDC_ISSUER: ${OIDC_ISSUER:-http://127.0.0.1:${AUTH_HOST_PORT:-3100}}
      OIDC_INTERNAL_URL: http://auth:3100
      CONSOLE_URL: ${CONSOLE_URL:-http://127.0.0.1:${CONTROL_PLANE_PORT:-3200}}
      CONSOLE_CLIENT_SECRET: ${CONSOLE_CLIENT_SECRET:?set CONSOLE_CLIENT_SECRET — run scripts/new-stack.sh}
```

and in its `depends_on`, after the `migrate` entry:

```yaml
      auth:
        condition: service_healthy
```

Then add a new service between `control-plane` and `data-plane`:

```yaml
  # The sign-in service (OpenID Provider). Same loopback posture as the console: it holds the
  # password form and signs every token. Forward its port alongside the console's.
  auth:
    image: ghcr.io/carmelosantana/metamodels-runtime:${TAG:-0.4.0}
    restart: unless-stopped
    working_dir: /app/apps/auth
    command: ["pnpm", "start"]
    environment:
      DATABASE_URL: ${DATABASE_URL:-postgres://${POSTGRES_USER:-metamodels}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-metamodels}}
      OIDC_ISSUER: ${OIDC_ISSUER:-http://127.0.0.1:${AUTH_HOST_PORT:-3100}}
      CONSOLE_URL: ${CONSOLE_URL:-http://127.0.0.1:${CONTROL_PLANE_PORT:-3200}}
      CONSOLE_CLIENT_SECRET: ${CONSOLE_CLIENT_SECRET:?set CONSOLE_CLIENT_SECRET — run scripts/new-stack.sh}
      OIDC_COOKIE_KEYS: ${OIDC_COOKIE_KEYS:?set OIDC_COOKIE_KEYS — run scripts/new-stack.sh}
      OIDC_SIGNING_KEY: ${OIDC_SIGNING_KEY:?set OIDC_SIGNING_KEY — run scripts/new-stack.sh}
      # Hard-wired, not a variable: a deployed stack must never mint a throwaway signing key.
      OIDC_ALLOW_EPHEMERAL_KEY: "false"
      AUTH_PORT: 3100
    ports:
      - "${AUTH_BIND:-127.0.0.1}:${AUTH_HOST_PORT:-3100}:3100"
    depends_on:
      postgres:
        condition: service_healthy
      migrate:
        condition: service_completed_successfully
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3100/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 5
```

- [ ] **Step 5: Keep env files out of image layers**

The `deps` stage runs `COPY . .`, and `.dockerignore` only excludes `.env`. Append to `.dockerignore`:

```
.env.*
```

Otherwise a local build copies `.env.verify` (Step 9), or a `new-stack.sh --out` file, into a layer.

- [ ] **Step 6: Verify the three stacks resolve**

Run: `docker compose --env-file .env.example config --services | grep -x auth`
Expected: `auth`.

Run: `docker compose -f docker-compose.deploy.yml --env-file .env.example config --services | grep -x auth`
Expected: `auth`.

Run (the four pre-existing secrets only; `--env-file /dev/null` so no local `.env` leaks in):

```bash
POSTGRES_PASSWORD=x SESSION_SECRET=x LICENSE_KEY_SECRET=x OPERATOR_PASSWORD=x \
  docker compose -f docker-compose.portainer.yml --env-file /dev/null config -q
```

Expected: non-zero exit, with an error naming one of `CONSOLE_CLIENT_SECRET`, `OIDC_COOKIE_KEYS` or `OIDC_SIGNING_KEY`.

Run (all seven):

```bash
POSTGRES_PASSWORD=x SESSION_SECRET=x LICENSE_KEY_SECRET=x OPERATOR_PASSWORD=x \
CONSOLE_CLIENT_SECRET=x OIDC_COOKIE_KEYS=x OIDC_SIGNING_KEY=x \
  docker compose -f docker-compose.portainer.yml --env-file /dev/null config --format json \
  | jq -c '[.services.auth.ports[0].host_ip, .services.auth.environment.OIDC_ALLOW_EPHEMERAL_KEY,
            .services.auth.environment.OIDC_ISSUER, .services["control-plane"].environment.CONSOLE_URL,
            .services["control-plane"].environment.OIDC_INTERNAL_URL, .services.auth.image]'
```

Expected: `["127.0.0.1","false","http://127.0.0.1:3100","http://127.0.0.1:3200","http://auth:3100","ghcr.io/carmelosantana/metamodels-runtime:0.4.0"]`

- [ ] **Step 7: Make the smoke test safe to run anywhere**

Today `smoke.sh` runs under compose's default project name, which is the directory name. From the checkout that also runs the operator's real stack, its `trap cleanup` (`down -v`) deletes that stack's database volume. It also hardcodes the host ports. Replace the whole of `scripts/smoke.sh` with:

```bash
#!/usr/bin/env bash
# Bring the whole stack up from a clean state, verify migrate, health and the sign-in hand-off,
# then tear down. Requires a Docker daemon.
#
#   ./scripts/smoke.sh                        # .env.example: host ports 3000 / 8787 / 3100
#   ENV_FILE=.env.verify ./scripts/smoke.sh   # another env file; its ports and URLs move the probes
set -euo pipefail

ENV_FILE="${ENV_FILE:-.env.example}"
# A dedicated compose project. Without -p, compose names the project after the directory, so
# running this from a checkout that also hosts a real stack would `down -v` that stack — and
# its database volume — on exit.
PROJECT="${SMOKE_PROJECT:-metamodels-smoke}"
COMPOSE="docker compose -p ${PROJECT} --env-file ${ENV_FILE}"

# Probe the ports and URLs from the same file compose interpolates.
case "$ENV_FILE" in */*) ENV_PATH="$ENV_FILE" ;; *) ENV_PATH="./$ENV_FILE" ;; esac
set -a; . "$ENV_PATH"; set +a
: "${OIDC_ISSUER:?OIDC_ISSUER must be set in $ENV_FILE}"
CONSOLE="http://localhost:${CONTROL_PLANE_PORT:-3000}"
PROXY="http://localhost:${DATA_PLANE_PORT:-8787}"
AUTH="http://localhost:${AUTH_HOST_PORT:-3100}"

cleanup() { $COMPOSE down -v --remove-orphans >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== building + starting stack (project ${PROJECT}) =="
$COMPOSE up -d --build

echo "== waiting for migrate to complete =="
# migrate is a one-shot; it should exit 0. Wait for it to finish, then check its exit code.
# `up -d` already blocks on migrate via depends_on: service_completed_successfully, so by the
# time we get here migrate has exited. Some compose versions make `wait` error ("no containers")
# on an already-exited service, so tolerate that; the exit-code check below is the real assertion.
$COMPOSE wait migrate >/dev/null 2>&1 || true
code=$($COMPOSE ps -a --format '{{.ExitCode}}' migrate)
if [ "$code" != "0" ]; then echo "migrate exited $code"; $COMPOSE logs migrate; exit 1; fi
echo "migrate OK"

echo "== waiting for health endpoints =="
for probe in \
  "data-plane ${PROXY}/healthz" \
  "data-plane ${PROXY}/readyz" \
  "auth ${AUTH}/healthz" \
  "auth ${AUTH}/.well-known/openid-configuration" \
  "control-plane ${CONSOLE}/api/healthz"; do
  name=$(echo "$probe" | awk '{print $1}')
  url=$(echo "$probe" | awk '{print $2}')
  ok=""
  for _ in $(seq 1 30); do
    if curl -fsS "$url" >/dev/null 2>&1; then ok=1; break; fi
    sleep 2
  done
  if [ -z "$ok" ]; then echo "FAILED: $name $url"; $COMPOSE logs "$name"; exit 1; fi
  echo "OK: $name $url"
done

echo "== checking the sign-in hand-off =="
# /login must answer 303 with a Location on the PUBLIC issuer. That proves the console reached
# the auth service over the compose network (OIDC_INTERNAL_URL) AND re-homed the browser-facing
# endpoint onto OIDC_ISSUER rather than http://auth:3100, which no browser can resolve.
read -r status location < <(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' "${CONSOLE}/login")
if [ "$status" != "303" ] || [[ "${location:-}" != "${OIDC_ISSUER}/auth?"* ]]; then
  echo "FAILED: /login answered ${status} -> ${location:-<none>} (expected 303 -> ${OIDC_ISSUER}/auth?...)"
  $COMPOSE logs control-plane auth
  exit 1
fi
echo "OK: console /login -> ${OIDC_ISSUER}/auth"

echo "== smoke passed =="
```

CI's `build-smoke` job runs `./scripts/smoke.sh` with no arguments, so it keeps working unchanged under the new project name.

- [ ] **Step 8: Generate the new secrets**

Replace the whole of `scripts/new-stack.sh` with:

```bash
#!/usr/bin/env bash
# Generate a paste-ready environment block for the MetaModels Portainer stack.
#
#   ./scripts/new-stack.sh                      # print the block
#   ./scripts/new-stack.sh --out .env.portainer # also write it to a file (mode 600)
#   ./scripts/new-stack.sh --domain api.example.com --tag 0.4.0 --email me@example.com
#
# Secrets are URL-safe hex on purpose: POSTGRES_PASSWORD is interpolated into DATABASE_URL,
# so a password containing :/@?# would produce a malformed connection string.
set -euo pipefail

DOMAIN='api.metamodels.cc'
TAG='0.4.0'
EMAIL='admin@metamodels.cc'
OUT=''

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:?--domain needs a value}"; shift 2 ;;
    --tag)    TAG="${2:?--tag needs a value}";       shift 2 ;;
    --email)  EMAIL="${2:?--email needs a value}";   shift 2 ;;
    --out)    OUT="${2:?--out needs a path}";        shift 2 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }

# 32 bytes of hex = 64 chars, comfortably above the >=16-char floor every secret enforces.
gen() { openssl rand -hex 32; }
# The token-signing key: RSA-2048 as a PKCS#8 PEM (genpkey's default), base64'd onto one line
# so it survives being a KEY=value environment variable.
genkey() { openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null | openssl base64 -A; }

BLOCK=$(cat <<EOF
# MetaModels stack — generated $(date -u +%Y-%m-%dT%H:%M:%SZ)
# Paste into Portainer › Stacks › Environment variables. Keep this out of git.
TAG=${TAG}
API_DOMAIN=${DOMAIN}
OPERATOR_EMAIL=${EMAIL}
POSTGRES_PASSWORD=$(gen)
SESSION_SECRET=$(gen)
LICENSE_KEY_SECRET=$(gen)
OPERATOR_PASSWORD=$(gen)
CONSOLE_CLIENT_SECRET=$(gen)
OIDC_COOKIE_KEYS=$(gen)
OIDC_SIGNING_KEY=$(genkey)
EOF
)

if [ -n "$OUT" ]; then
  if [ -e "$OUT" ]; then
    echo "refusing to overwrite existing file: $OUT" >&2
    echo "(rotating secrets in place would orphan the encrypted license key — see below)" >&2
    exit 1
  fi
  ( umask 077; printf '%s\n' "$BLOCK" > "$OUT" )
  echo "wrote $OUT (mode $(stat -c '%a' "$OUT"))"
  echo
fi

printf '%s\n' "$BLOCK"

cat <<'NOTE'

--------------------------------------------------------------------------------
Store these now — they are not recoverable from the running stack.

  LICENSE_KEY_SECRET  encrypts the stored Lemon Squeezy license key at rest.
                      Losing or changing it makes an existing entitlement
                      undecryptable and you must re-activate the license.
  OPERATOR_PASSWORD   only used by `pnpm seed` to create the first admin.
                      Change it in the console after first login.
  OIDC_SIGNING_KEY    signs every token the sign-in service issues. Changing
                      it signs everyone out and invalidates every token.
  OIDC_COOKIE_KEYS    signs the sign-in service's cookies. Rotate without
                      signing anyone out by prepending: <new>,<old>

Next: paste docker-compose.portainer.yml as the stack, add the block above as the
stack's environment variables, and deploy. The first operator is seeded
automatically. The console and the sign-in service are loopback-only by default,
so forward both ports, then open http://127.0.0.1:3200 (exactly — it is CONSOLE_URL):

  ssh -L 3200:127.0.0.1:3200 -L 3100:127.0.0.1:3100 <host>
--------------------------------------------------------------------------------
NOTE
```

Run: `bash scripts/new-stack.sh | sed -n 's/^OIDC_SIGNING_KEY=//p' | openssl base64 -d -A | head -1`
Expected: `-----BEGIN PRIVATE KEY-----`

- [ ] **Step 9: Run the smoke test on throwaway ports**

The operator's own stack may already hold 3000, 8787 and 3100 on this machine. Generate a scratch env file with every host port and both public URLs moved. It is ignored by git (`.env.*` in `.gitignore`) and by Docker (Step 5). Task 13 reuses it.

```bash
sed -e 's/^CONTROL_PLANE_PORT=.*/CONTROL_PLANE_PORT=13000/' \
    -e 's/^DATA_PLANE_PORT=.*/DATA_PLANE_PORT=18787/' \
    -e 's/^AUTH_HOST_PORT=.*/AUTH_HOST_PORT=13100/' \
    -e 's#^OIDC_ISSUER=.*#OIDC_ISSUER=http://localhost:13100#' \
    -e 's#^CONSOLE_URL=.*#CONSOLE_URL=http://localhost:13000#' \
    .env.example > .env.verify
```

Run: `ENV_FILE=.env.verify ./scripts/smoke.sh`
Expected: ends with `OK: console /login -> http://localhost:13100/auth` then `== smoke passed ==`. Afterwards `docker compose ls --all | grep metamodels-smoke` prints nothing: the project tore itself down.

- [ ] **Step 10: Document it (`docs/DEPLOY.md`)**

Make these edits, in order:

1. Line 3: replace `and three app services (control-plane UI, data-plane proxy, metering worker).` with `and four app services (control-plane UI, auth sign-in service, data-plane proxy, metering worker).`
2. Quickstart: replace `# then edit .env — set the two secrets and the operator login` with `# then edit .env — set the secrets and the operator login`, and add below the `- Data-plane proxy:` bullet:

```markdown
- Sign-in service: http://localhost:3100 — the console sends your browser here to sign in, so it must be reachable at exactly `OIDC_ISSUER`
```

3. Replace the paragraph starting `If either host port is already taken` with:

```markdown
If a host port is already taken on your machine, set `CONTROL_PLANE_PORT` / `DATA_PLANE_PORT` / `AUTH_HOST_PORT` in `.env` — only the host side of the mapping moves, so healthchecks and inter-container URLs are unaffected. Moving the console or sign-in port also moves its public URL: update `CONSOLE_URL` / `OIDC_ISSUER` to match.
```

4. Environment table: insert after the `SESSION_SECRET` row:

```markdown
| `OIDC_ISSUER` | auth, control-plane | Public URL of the sign-in service, origin only. Also the token issuer, so browsers and clients must see exactly this. |
| `CONSOLE_URL` | auth, control-plane | Public URL of the console, origin only. Its sign-in redirect and post-logout URIs derive from it. |
| `OIDC_INTERNAL_URL` | control-plane | How the console reaches the sign-in service server-to-server: `http://auth:3100` in compose. Defaults to `OIDC_ISSUER`. |
| `CONSOLE_CLIENT_SECRET` | auth, control-plane | ≥16 chars, the same value in both. `openssl rand -hex 32`. |
| `OIDC_COOKIE_KEYS` | auth | Cookie-signing keys, comma-separated, newest first, each ≥16 chars. |
| `OIDC_SIGNING_KEY` | auth | Base64 of an RSA ≥2048-bit PKCS#8 PEM that signs every token: `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \| openssl base64 -A`. |
| `OIDC_ALLOW_EPHEMERAL_KEY` | auth | Local development and CI only: with no `OIDC_SIGNING_KEY`, mint a throwaway key at boot. Never in production. |
| `AUTH_PORT` | auth | Listen port inside the container. Compose pins it to `3100`; move `AUTH_HOST_PORT` instead. |
```

   and after the `DATA_PLANE_PORT` row:

```markdown
| `AUTH_HOST_PORT` | compose | Host port for the sign-in service. Default `3100`. |
```

5. Portainer section: replace `minimal deploy only needs four secrets.` with `minimal deploy only needs seven secrets.`; `block with four 64-hex-char secrets.` with `block with six 64-hex-char secrets and an RSA signing key.`; `--tag 0.3.0` with `--tag 0.4.0`; `Four secrets are **required**` with `Seven secrets are **required**`.
6. Required-secret table: add after the `OPERATOR_PASSWORD` row:

```markdown
| `CONSOLE_CLIENT_SECRET` | authenticates the console to the sign-in service (≥16 chars; both services read it) |
| `OIDC_COOKIE_KEYS` | signs the sign-in service's cookies. Rotate by prepending a new key: `<new>,<old>` |
| `OIDC_SIGNING_KEY` | signs every token (base64 of an RSA PKCS#8 PEM). **Changing it signs everyone out** |
```

7. Defaults table: replace the `TAG` row with

```markdown
| `TAG` | `0.4.0` | Image tag. The git tag `v0.4.0` publishes images as `0.4.0` — the `v` is stripped |
```

   and add after the `CONTROL_PLANE_PORT` row:

```markdown
| `AUTH_BIND` / `AUTH_HOST_PORT` | `127.0.0.1` / `3100` | The sign-in service — loopback, like the console |
| `CONSOLE_URL` | `http://127.0.0.1:<CONTROL_PLANE_PORT>` | Where you open the console. Must match your browser's address bar exactly |
| `OIDC_ISSUER` | `http://127.0.0.1:<AUTH_HOST_PORT>` | Where browsers reach the sign-in service; also the token issuer |
```

8. Append to the section **The two planes are not equally public**:

```markdown
The **sign-in service** (`auth`) is admin-side too and binds to `127.0.0.1` by default. The
console sends your browser to it to sign in, so forward **both** ports —
`ssh -L 3200:127.0.0.1:3200 -L 3100:127.0.0.1:3100 <host>` — then open exactly `CONSOLE_URL`.
If you put either behind TLS, set `CONSOLE_URL` and `OIDC_ISSUER` to the public `https://`
origins: both are compared exactly, and a mismatch fails sign-in with an issuer or
redirect-URI error.

### Rotating the sign-in keys

- **`OIDC_COOKIE_KEYS`** — prepend a new key (`<new>,<old>`) and redeploy: new cookies are
  signed with it and old ones still verify. Drop the old key after a day.
- **`OIDC_SIGNING_KEY`** — replacing it invalidates every issued token and signs every operator
  out of the console. Do it deliberately, e.g. after a suspected leak.
- **`CONSOLE_CLIENT_SECRET`** — both services read the same stack variable, so change it and
  redeploy; nobody is signed out.
```

9. Deploy gotchas: in the first bullet, replace `The control-plane login throttle keys on` with `The sign-in throttle (in the auth service) keys on`.

- [ ] **Step 11: Commit**

```bash
git add docker-compose.yml docker-compose.deploy.yml docker-compose.portainer.yml .dockerignore \
        scripts/smoke.sh scripts/new-stack.sh docs/DEPLOY.md
git commit -m "feat(deploy): run the auth service in every stack

Adds the auth service to the dev, deploy and Portainer stacks (loopback by
default in Portainer), generates its three secrets in new-stack.sh, and moves
the stack default TAG to 0.4.0. smoke.sh now runs under its own compose
project so it can never tear down a real stack, reads its ports from ENV_FILE,
and checks that /login hands off to the public issuer."
```

---

### Task 13: Verify end to end, then hand off

An acceptance test of Tasks 11 and 12 against a real stack in a real browser. The code under test already exists, so there is **no red phase**. What this task proves is that the pieces the unit lanes stub out work together: the browser redirects, the cookies across two origins, the CSP of both origins, and the compose network.

**Files:**
- Create: `apps/e2e/specs/sign-in.spec.ts`
- Modify: `apps/e2e/specs/helpers/env.ts`
- Modify: `apps/e2e/README.md`
- Modify: `packages/schema/test/env-example.test.ts` (`EXCLUDED`)

**Interfaces:**
- Consumes: the console's **Sign out** button (`app/(app)/layout.tsx`); the OP pages from Task 6: labels `Email` / `Password`, button `Sign in`, heading `Sign out of MetaModels?` with a `Sign out` button, and the error text `Invalid email or password.`; `watchForViolations` (existing, `specs/helpers/console.ts`); `.env.verify` (Task 12).
- Produces: `AUTH_URL` in `specs/helpers/env.ts`, read from `E2E_AUTH_URL` (default `http://localhost:3100`).

- [ ] **Step 1: Write the spec**

In `apps/e2e/specs/helpers/env.ts`, add after the `PROXY_URL` export:

```ts
/** Auth service (sign-in). Must equal the stack's OIDC_ISSUER — the console redirects there. */
export const AUTH_URL = process.env.E2E_AUTH_URL ?? 'http://localhost:3100'
```

In `packages/schema/test/env-example.test.ts`, add `'E2E_AUTH_URL',` to `EXCLUDED` directly after `'E2E_PROXY_URL',`.

Create `apps/e2e/specs/sign-in.spec.ts`:

```ts
import { expect, test, type Page } from '@playwright/test'
import { watchForViolations } from './helpers/console.js'
import { AUTH_URL, CONTROL_PLANE_URL, OPERATOR_EMAIL, OPERATOR_PASSWORD } from './helpers/env.js'

/**
 * Sign-in through the auth service. Needs only the stack — no upstream model — so unlike the
 * acceptance walkthrough it never skips.
 */
test.describe.configure({ mode: 'serial' })

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const ON_AUTH_FORM = new RegExp(`^${escapeRe(AUTH_URL)}/interaction/`)

async function consoleSession(page: Page) {
  return (await page.context().cookies(CONTROL_PLANE_URL)).find((c) => c.name === 'mm_session')
}

test('the console hands sign-in to the auth service and back, then signs out of both', async ({ page }) => {
  const problems = watchForViolations(page)

  await page.goto('/login')
  await expect(page).toHaveURL(ON_AUTH_FORM)
  await page.getByLabel('Email').fill(OPERATOR_EMAIL)
  await page.getByLabel('Password').fill(OPERATOR_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()

  // Back on the console, authenticated: the nav only renders for a signed-in operator.
  await expect(page.getByRole('link', { name: 'Paddocks' })).toBeVisible()
  expect(new URL(page.url()).origin).toBe(new URL(CONTROL_PLANE_URL).origin)
  const session = await consoleSession(page)
  expect(session?.httpOnly).toBe(true)
  expect(session?.sameSite).toBe('Lax')

  // RP-initiated logout: the console drops its session, then the OP asks to end its own.
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('heading', { name: 'Sign out of MetaModels?' })).toBeVisible()
  await page.getByRole('button', { name: 'Sign out' }).click()

  // Signed out of the OP too: the console's /login bounces straight to a fresh password form
  // instead of silently signing back in.
  await expect(page).toHaveURL(ON_AUTH_FORM)
  await expect(page.getByLabel('Password')).toBeVisible()
  expect(await consoleSession(page)).toBeUndefined()

  // Both origins' policies held across every redirect, including form-action on the way out.
  expect(problems).toEqual([])
})

test('a wrong password stays on the auth service and mints no console session', async ({ page }) => {
  const problems = watchForViolations(page)

  await page.goto('/login')
  await page.getByLabel('Email').fill(OPERATOR_EMAIL)
  await page.getByLabel('Password').fill(`${OPERATOR_PASSWORD}-wrong`)
  await page.getByRole('button', { name: 'Sign in' }).click()

  await expect(page.getByText('Invalid email or password.')).toBeVisible()
  await expect(page).toHaveURL(ON_AUTH_FORM)
  expect(await consoleSession(page)).toBeUndefined()
  expect(problems).toEqual([])
})
```

Run: `pnpm exec vitest run packages/schema/test/env-example.test.ts`
Expected: PASS — `E2E_AUTH_URL` is test-only and excluded, like `E2E_BASE_URL`.

- [ ] **Step 2: Bring up a throwaway stack**

Never point this at the operator's own stack: it has real keys in it. Run under a dedicated project on moved ports. If Task 12's `.env.verify` is gone, recreate it:

```bash
sed -e 's/^CONTROL_PLANE_PORT=.*/CONTROL_PLANE_PORT=13000/' \
    -e 's/^DATA_PLANE_PORT=.*/DATA_PLANE_PORT=18787/' \
    -e 's/^AUTH_HOST_PORT=.*/AUTH_HOST_PORT=13100/' \
    -e 's#^OIDC_ISSUER=.*#OIDC_ISSUER=http://localhost:13100#' \
    -e 's#^CONSOLE_URL=.*#CONSOLE_URL=http://localhost:13000#' \
    .env.example > .env.verify
```

```bash
docker compose -p mm-verify --env-file .env.verify up -d --build
timeout 300 bash -c 'until curl -fsS http://localhost:13000/api/healthz >/dev/null && curl -fsS http://localhost:13100/healthz >/dev/null; do sleep 2; done' && echo up
docker compose -p mm-verify --env-file .env.verify run --rm control-plane pnpm seed
```

Expected: `up`, then `Seeded admin admin@example.com`.

- [ ] **Step 3: Run the spec**

```bash
pnpm --filter @metamodels/e2e exec playwright install chromium
E2E_BASE_URL=http://localhost:13000 E2E_AUTH_URL=http://localhost:13100 \
  pnpm --filter @metamodels/e2e exec playwright test specs/sign-in.spec.ts
```

Expected: `2 passed`. On failure, `pnpm --filter @metamodels/e2e report` opens the trace, and `docker compose -p mm-verify --env-file .env.verify logs auth control-plane` shows both sides.

- [ ] **Step 4: Probe the security properties directly**

Run: `curl -sI http://localhost:13000/auth/error | grep -i '^content-security-policy' | grep -o "form-action[^;]*"`
Expected: `form-action 'self' http://localhost:13100`. This is the runtime value from the container's env, which is the reason for Task 11's `runtime: 'nodejs'`.

Run: `curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:13000/login`
Expected: `405` — the console no longer accepts a password at all.

Run (an unregistered `redirect_uri`):

```bash
curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:13100/auth?client_id=metamodels-console&response_type=code&scope=openid&state=s&redirect_uri=http%3A%2F%2Fevil.example%2Fcb&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256"
```

Expected: `400`. The OP renders an error page and never redirects to an unregistered URI.

- [ ] **Step 5: Tear down, then run every lane**

```bash
docker compose -p mm-verify --env-file .env.verify down -v --remove-orphans
ENV_FILE=.env.verify ./scripts/smoke.sh
pnpm --filter @metamodels/control-plane build
pnpm typecheck
pnpm test
pnpm --filter @metamodels/control-plane exec vitest run --testTimeout=30000
rm .env.verify
docker compose ls --all | grep -E 'mm-verify|metamodels-smoke' || echo "no leftover stacks"
```

Expected: `== smoke passed ==`; the build and typecheck exit 0; both vitest lanes pass; `no leftover stacks`.

- [ ] **Step 6: Document it (`apps/e2e/README.md`)**

After the paragraph that ends `this walkthrough happens to visit every screen.`, add:

```markdown
### Sign-in (`specs/sign-in.spec.ts`)

Signing in is handed to the auth service (`apps/auth`, an OpenID Provider). This spec proves
the round trip in a real browser: `/login` lands on the auth service's password form, a
correct password comes back to a signed-in console with an `HttpOnly`, `SameSite=Lax`
session cookie, a wrong one stays on the form and mints nothing, and **Sign out** ends the
auth service's session as well as the console's. No CSP violation is tolerated on either
origin. It needs no upstream model, so it never skips.
```

Replace the paragraph starting `Without \`OLLAMA_TEST_URL\` the suite **skips**` with:

```markdown
Without `OLLAMA_TEST_URL` the walkthrough **skips** rather than fails — the same opt-in
convention as the `PG_TEST_URL` / `REDIS_TEST_URL` integration suites. The sign-in spec
still runs.
```

Add to the variables table, after the `E2E_PROXY_URL` row:

```markdown
| `E2E_AUTH_URL` | `http://localhost:3100` | Auth service. Must equal the stack's `OIDC_ISSUER` |
```

- [ ] **Step 7: Commit**

```bash
git add apps/e2e packages/schema/test/env-example.test.ts
git commit -m "test(e2e): cover sign-in and sign-out through the auth service"
```

---

## Handoff to M2 and M4

These hold after M1. Each is a constraint on a later milestone, not unfinished M1 work.

- **Release.** Tag `v0.4.0` from `main` right after this PR merges (Task 12). The Portainer stack's default `TAG` already points at it.
- **Resource servers verify offline.** The admin API (M2) checks RFC 9068 JWTs:
  - header `typ: at+jwt`;
  - `iss` = `OIDC_ISSUER`;
  - `aud` = `adminApiResource(CONSOLE_URL)`, imported from `@metamodels/schema` and never re-typed;
  - RS256 against `/jwks`, fetched through `OIDC_INTERNAL_URL` with `onOrigin`, like the console;
  - granted scopes ∩ the user's role capabilities (spec §2, C3);
  - `aud` is minted as a bare string, but RFC 9068 allows a string or an array, so verifiers must accept both;
  - resolve `kid` from `/jwks` (e.g. `createRemoteJWKSet`) and never pin it;
  - the JWKS publishes a single key, so rotating `OIDC_SIGNING_KEY` has no overlap window and in-flight tokens fail at once. Before M2 relies on access tokens, publish the previous key alongside the new one during rotation;
  - `/healthz` does not touch the database, so `auth` reports healthy while Postgres is down;
  - the OP session is capped to the console session lifetime (`OPERATOR_SESSION_TTL_MS`, 12 hours). A future CLI or device client needs its own decision about session length.
- **Restrict resources per client before a second client exists.** In M1 any client may ask for the admin-API resource. Only the console is registered, and it never asks. `makeGetResourceServerInfo` receives the client as its third argument: gate on it the moment M2 registers the CLI (device grant) or M4 admits CIMD clients.
- **Consent (M4).** Third-party clients get `access_denied` at the consent prompt today (Task 7). The consent screen replaces exactly that branch; first-party auto-consent stays keyed on `CONSOLE_CLIENT_ID`.
- **The OP's `form-action` lists only the console origin.** A CIMD client's redirect origin must be added per interaction (`authCsp(redirectOrigins)`). Otherwise Chrome blocks the post-consent redirect, because it enforces `form-action` across redirects.
- **`response_mode=form_post` has no working page yet.** oidc-provider auto-submits it with an inline script, which the OP's `default-src 'none'` blocks. The console never uses it. Before any client relies on it, render a CSP-compatible page: a nonce'd script, or a visible **Continue** button.
- **API-key deletion over the admin API (M2) is a revoke.** It goes through the existing key service, with its audit entry and org scoping (spec §4.3). It is never a SQL delete.
- **Discovery is host-relative.** oidc-provider builds endpoint URLs from the request host. Any server-side consumer that fetches discovery over a private hop must re-home the browser-facing endpoints onto the issuer, as `OidcClient.metadata()` does.
