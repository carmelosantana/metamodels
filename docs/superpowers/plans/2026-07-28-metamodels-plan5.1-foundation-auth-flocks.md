# MetaModels Plan 5.1 — Control-Plane Foundation + Auth + Flocks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `apps/control-plane` Next.js operator console with multi-user-capable email+password auth, the `authorize()` role model used by all future CRUD, the reusable service pattern (Zod → authorize → org-scope → mutate → audit), and Flocks CRUD end-to-end including Test-connection.

**Architecture:** All business logic lives in **Next-free, unit-tested modules** (`src/auth/*`, `src/server/*-service.ts`, `src/lib/*`) exactly like the data-plane — tested with `vitest` + `pglite` running the real Drizzle migrations. React Server Components + Server Actions are **thin shells** that call those tested services; they carry no logic worth unit-testing and are gated by `pnpm build` + `tsc`. Authentication is a signed HMAC httpOnly cookie (Node `crypto`, no third-party session lib); passwords use Node `crypto.scrypt` (no native KDF addon). `authorize(user, action)` is a single pure capability matrix consulted by every write path.

**Tech Stack:** Next.js ≥16.2 (App Router, RSC + Server Actions), React 19, Tailwind CSS v4 (CSS-first `@theme`), Drizzle ORM + Postgres (pglite in tests), Node `crypto` (scrypt + HMAC), Zod, vitest, `@metamodels/schema` + `@metamodels/connectors` workspace packages.

## Global Constraints

- **Node** `>=24` (root `engines`); ESM only (`"type": "module"`).
- **Supply chain:** `.npmrc` enforces `minimumReleaseAge=1440` + `blockExoticSubdeps=true`. Every new dependency is **pinned exact** (no `^`/`~`) and vetted. Run the `superpowers:supply-chain-risk-mitigation` skill before adding the Next.js/React/Tailwind deps in Task 1; record resolved exact versions in the SDD ledger.
- **Next.js floor ≥ 16.2** (avoids CVE-2025-66478). Pin the exact latest patch ≥16.2 that the quarantine allows.
- **No new runtime crypto/session/KDF dependency:** use Node `crypto` (`scrypt`, `createHmac`, `timingSafeEqual`, `randomBytes`). No bcrypt/argon2/native addons, no Auth.js, no Radix in this plan.
- **Migrations are additive only.** `0000`/`0001` are frozen; add a new numbered migration. Regenerate via `drizzle-kit`, never hand-edit prior migrations.
- **Tests stay Docker-free:** pglite + `migrate(db, { migrationsFolder })` against `packages/schema/drizzle`; stub `global.fetch` for upstream health.
- **Secrets never in plaintext:** `passwordHash` stores a salted scrypt digest; session cookie is signed, `httpOnly`, `secure`, `sameSite=lax`; the license/API surfaces are out of scope here.
- **`authorize()` is the boundary.** UI hiding is convenience only; every mutating service calls `requireCapability` server-side. Never trust a client-asserted role.
- **Herding vocabulary** in all copy: Flock (upstream), Paddock (endpoint), Fence (policy). Field names map 1:1 to `packages/schema/src/schema.ts`.
- **Design reference:** operator-mode tokens + screens `shell` and `9a Flocks` in `docs/design_v2/` (`design-spec.json` is source of truth; `screenshots/9a-flocks.png`). shadcn-pattern primitives are **hand-authored** in this plan (Radix/shadcn-CLI deferred) to honor the supply-chain constraint — this is a deliberate, recorded deviation, refinable in a later polish pass.

---

## File Structure

**New package `apps/control-plane/` (Next.js App Router):**

| Path | Responsibility |
|---|---|
| `package.json`, `next.config.ts`, `tsconfig.json`, `postcss.config.mjs`, `vitest.config.ts`, `next-env.d.ts` | App config, workspace wiring, security headers, test runner. |
| `src/app/globals.css` | Tailwind v4 `@import` + `@theme` operator-mode tokens. |
| `src/app/layout.tsx` | Root HTML layout, fonts, base theme class. |
| `src/app/login/page.tsx`, `src/app/login/actions.ts` | Login screen + `login`/`logout` server actions (thin). |
| `src/app/(app)/layout.tsx` | Authed app shell: sidebar + header; redirects unauthenticated. |
| `src/app/(app)/page.tsx` | Placeholder dashboard landing (real dashboard is 5.5). |
| `src/app/(app)/flocks/page.tsx`, `.../flocks/actions.ts` | Flocks table + Connect drawer + row actions (thin, calls services). |
| `src/auth/password.ts` | `hashPassword` / `verifyPassword` (scrypt). **Next-free, tested.** |
| `src/auth/session.ts` | `signSession` / `verifySession` (HMAC token codec). **Next-free, tested.** |
| `src/auth/authorize.ts` | `Role`, `Capability`, `authorize`, `requireCapability`, `ForbiddenError`, `Actor`. **Next-free, tested.** |
| `src/auth/nav.ts` | `navItemsForRole(role)` — role-based nav model. **Next-free, tested.** |
| `src/auth/login-throttle.ts` | In-memory per-IP login throttle. **Next-free, tested.** |
| `src/server/db.ts` | Drizzle Postgres singleton from `DATABASE_URL`. |
| `src/server/audit.ts` | `writeAudit(db, entry)`. **Tested (pglite).** |
| `src/server/auth-service.ts` | `verifyLogin(db, email, password)` → `Actor | LoginError`. **Tested (pglite).** |
| `src/server/seed.ts` | `seedAdmin(db, {email, password, orgName})` idempotent first-run admin. **Tested (pglite).** |
| `src/server/current-user.ts` | Next glue: read cookie → `verifySession` → load `Actor`; `setSessionCookie`/`clearSessionCookie`. Thin. |
| `src/server/guard.ts` | `requireUser()` / `requireCapabilityFor(action)` for RSC/actions. Thin wrapper over `current-user` + `authorize`. |
| `src/server/flocks-service.ts` | `listFlocks` / `saveFlock` / `deleteFlock` (Zod → authorize → org-scope → mutate → audit). **Tested (pglite).** |
| `src/server/flock-health.ts` | `testFlockConnection(registry, {breed, baseUrl, upstreamAuth, tlsTrust})` → `{ok, detail?}`. **Tested (fetch stub).** |
| `src/lib/flock-schema.ts` | Zod `saveFlockInput` / `flockConnectionInput`. **Tested implicitly + directly.** |
| `src/components/ui/*` | Hand-authored primitives: `button.tsx`, `input.tsx`, `label.tsx`, `select.tsx`, `switch.tsx`, `drawer.tsx`, `data-table.tsx`, `status-pill.tsx`, `breed-chip.tsx`, `cn.ts`. |
| `src/components/app-sidebar.tsx`, `src/components/page-header.tsx` | Shell chrome. |
| `bin/seed.ts` | CLI entry: `seedAdmin` from env (`OPERATOR_EMAIL`, `OPERATOR_PASSWORD`). |

**Modified `packages/schema/`:**

| Path | Change |
|---|---|
| `src/schema.ts` | `user`: add `status text NOT NULL DEFAULT 'active'`. |
| `src/enums.ts` | Add `USER_ROLES`, `USER_STATUS` enums. |
| `drizzle/0002_*.sql` + `drizzle/meta/*` | New generated migration (regenerate, don't hand-write). |
| `test/schema.test.ts` | Add a `user.status` default/insert test. |

**Modified root:** `tsconfig.json` (add `apps/control-plane` reference).

**Testing note (applies to every task):** the control-plane test helper mirrors `packages/schema/test/schema.test.ts`:

```ts
// src/test/db.ts
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as schema from '@metamodels/schema'

const migrationsFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/schema/drizzle',
)

export type TestDb = ReturnType<typeof drizzle<typeof schema>>

export async function freshDb(): Promise<TestDb> {
  const db = drizzle(new PGlite(), { schema })
  await migrate(db, { migrationsFolder })
  return db
}

export async function seedOrg(db: TestDb, name = 'default') {
  const [o] = await db.insert(schema.org).values({ name }).returning()
  return o
}
```

This helper file is created in Task 3 (first task that needs pglite) and reused thereafter.

---

## Task 1: Scaffold `apps/control-plane` (Next.js + Tailwind + tokens + headers)

**Files:**
- Create: `apps/control-plane/package.json`, `apps/control-plane/next.config.ts`, `apps/control-plane/tsconfig.json`, `apps/control-plane/postcss.config.mjs`, `apps/control-plane/next-env.d.ts`, `apps/control-plane/vitest.config.ts`
- Create: `apps/control-plane/src/app/globals.css`, `apps/control-plane/src/app/layout.tsx`, `apps/control-plane/src/app/(app)/page.tsx`
- Create: `apps/control-plane/src/components/ui/cn.ts`
- Modify: root `tsconfig.json` (add reference)

**Interfaces:**
- Produces: the `@metamodels/control-plane` workspace package; `cn(...classes)` string joiner used by all UI; operator-mode CSS variables (`--color-bg`, `--color-panel`, `--color-border`, `--color-text`, `--color-muted`, `--color-primary`, `--color-comfyui`, `--color-danger`, radii).

- [ ] **Step 1: Add the package and pin deps (supply-chain gate first)**

Run the `supply-chain-risk-mitigation` skill, then create `apps/control-plane/package.json`. Resolve exact latest versions ≥ the floors below (the `.npmrc` quarantine picks quarantine-safe versions) and pin them **exact** — record them in the SDD ledger:

```jsonc
{
  "name": "@metamodels/control-plane",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "seed": "tsx bin/seed.ts"
  },
  "dependencies": {
    "@metamodels/connectors": "workspace:*",
    "@metamodels/schema": "workspace:*",
    "drizzle-orm": "^0.45.2",
    "next": "16.2.0",
    "postgres": "^3.4.0",
    "react": "19.2.0",
    "react-dom": "19.2.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@electric-sql/pglite": "^0.5.4",
    "@tailwindcss/postcss": "4.1.0",
    "@types/react": "19.2.0",
    "@types/react-dom": "19.2.0",
    "tailwindcss": "4.1.0",
    "tsx": "^4.19.0"
  }
}
```

> `next`, `react`, `react-dom`, `tailwindcss`, `@tailwindcss/postcss`, and the `@types/*` are pinned exact. `next` MUST resolve to ≥16.2 (CVE-2025-66478). If the exact patch above is unavailable/older than the quarantine allows, bump to the nearest quarantine-safe ≥16.2 patch and record it. `drizzle-orm`/`postgres`/`zod`/`tsx`/`pglite` reuse the versions already in the monorepo lockfile.

Then `pnpm install` at the repo root.

- [ ] **Step 2: Create Next/TS/PostCSS config**

`apps/control-plane/next.config.ts` — App Router with security headers (§8):

```ts
import type { NextConfig } from 'next'

const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
]

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }]
  },
}

export default nextConfig
```

`apps/control-plane/tsconfig.json`:

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "preserve",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "verbatimModuleSyntax": false,
    "noEmit": true,
    "allowJs": true,
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] },
    "lib": ["ES2022", "DOM", "DOM.Iterable"]
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

> `verbatimModuleSyntax: false` and `jsx: preserve` diverge from the base config because React/Next require it. Imports inside this app are **extensionless** (Next convention) via the `@/*` alias.

`apps/control-plane/postcss.config.mjs`:

```js
export default { plugins: { '@tailwindcss/postcss': {} } }
```

`apps/control-plane/next-env.d.ts`:

```ts
/// <reference types="next" />
/// <reference types="next/image-types/global" />
```

- [ ] **Step 3: Operator-mode tokens in `globals.css`**

`apps/control-plane/src/app/globals.css` (values from `design-spec.json → tokens.operatorMode`):

```css
@import 'tailwindcss';

@theme {
  --color-bg: #141110;
  --color-panel: #1a1614;
  --color-panel-2: #1c1714;
  --color-border: #2e2620;
  --color-divider: #241d19;
  --color-input-border: #3a2f28;
  --color-text: #ece4d6;
  --color-muted: #9a8b7c;
  --color-faint: #7d6f62;
  --color-primary: #acb965;
  --color-on-primary: #23260f;
  --color-comfyui: #c08457;
  --color-danger: #cf5f4b;
  --radius-card: 9px;
  --radius-control: 7px;
  --radius-chip: 5px;
  --font-sans: 'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif;
  --font-mono: 'IBM Plex Mono', ui-monospace, monospace;
}

html, body {
  background: var(--color-bg);
  color: var(--color-text);
  font-family: var(--font-sans);
}
```

- [ ] **Step 4: Root layout + placeholder landing + `cn`**

`apps/control-plane/src/components/ui/cn.ts`:

```ts
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
```

`apps/control-plane/src/app/layout.tsx`:

```tsx
import './globals.css'
import type { ReactNode } from 'react'

export const metadata = { title: 'MetaModels', description: 'Operator console' }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  )
}
```

`apps/control-plane/src/app/(app)/page.tsx` (placeholder; real dashboard is Plan 5.5):

```tsx
export default function DashboardPage() {
  return <div className="p-8 text-[var(--color-muted)]">Dashboard — coming in Plan 5.5.</div>
}
```

- [ ] **Step 5: Wire root tsconfig + vitest config**

Add to root `tsconfig.json` `references`: `{ "path": "apps/control-plane" }`.

`apps/control-plane/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
```

- [ ] **Step 6: Verify build + typecheck (this task's gate)**

Run:
```bash
pnpm --filter @metamodels/control-plane build
```
Expected: build succeeds; `/` and `/(app)` compile.

Run:
```bash
pnpm --filter @metamodels/control-plane exec tsc --noEmit
```
Expected: no type errors.

- [ ] **Step 7: Commit**

```bash
git add apps/control-plane tsconfig.json pnpm-lock.yaml
git commit -m "feat(control-plane): scaffold Next.js app with operator-mode tokens + security headers"
```

---

## Task 2: `authorize()` role model

**Files:**
- Create: `apps/control-plane/src/auth/authorize.ts`
- Test: `apps/control-plane/src/auth/authorize.test.ts`

**Interfaces:**
- Produces:
  - `type Role = 'admin' | 'member' | 'viewer'`
  - `type Capability = 'read' | 'resource.write' | 'user.manage' | 'license.manage'`
  - `interface Actor { id: string; orgId: string; email: string; role: Role }`
  - `class ForbiddenError extends Error` (has `.capability: Capability`)
  - `function authorize(user: { role: Role }, action: Capability): boolean`
  - `function requireCapability(user: Actor, action: Capability): void` (throws `ForbiddenError`)
  - `function isRole(v: unknown): v is Role`
- Consumed by: every service (Tasks 8, 9) and `guard.ts` (Task 6).

- [ ] **Step 1: Write the failing test**

`apps/control-plane/src/auth/authorize.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { authorize, requireCapability, ForbiddenError, isRole, type Actor } from './authorize'

const actor = (role: Actor['role']): Actor => ({ id: 'u1', orgId: 'o1', email: 'a@b.c', role })

describe('authorize', () => {
  test('admin can do everything', () => {
    for (const cap of ['read', 'resource.write', 'user.manage', 'license.manage'] as const) {
      expect(authorize({ role: 'admin' }, cap)).toBe(true)
    }
  })

  test('member has full resource CRUD but no user/license management', () => {
    expect(authorize({ role: 'member' }, 'read')).toBe(true)
    expect(authorize({ role: 'member' }, 'resource.write')).toBe(true)
    expect(authorize({ role: 'member' }, 'user.manage')).toBe(false)
    expect(authorize({ role: 'member' }, 'license.manage')).toBe(false)
  })

  test('viewer is read-only', () => {
    expect(authorize({ role: 'viewer' }, 'read')).toBe(true)
    expect(authorize({ role: 'viewer' }, 'resource.write')).toBe(false)
    expect(authorize({ role: 'viewer' }, 'user.manage')).toBe(false)
  })

  test('requireCapability throws ForbiddenError with the capability attached', () => {
    expect(() => requireCapability(actor('viewer'), 'resource.write')).toThrow(ForbiddenError)
    try {
      requireCapability(actor('viewer'), 'resource.write')
    } catch (e) {
      expect((e as ForbiddenError).capability).toBe('resource.write')
    }
    expect(() => requireCapability(actor('member'), 'resource.write')).not.toThrow()
  })

  test('isRole validates the enum', () => {
    expect(isRole('admin')).toBe(true)
    expect(isRole('owner')).toBe(false)
    expect(isRole(null)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/auth/authorize.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`apps/control-plane/src/auth/authorize.ts`:

```ts
export type Role = 'admin' | 'member' | 'viewer'
export type Capability = 'read' | 'resource.write' | 'user.manage' | 'license.manage'

export interface Actor {
  id: string
  orgId: string
  email: string
  role: Role
}

const MATRIX: Record<Role, Record<Capability, boolean>> = {
  admin: { read: true, 'resource.write': true, 'user.manage': true, 'license.manage': true },
  member: { read: true, 'resource.write': true, 'user.manage': false, 'license.manage': false },
  viewer: { read: true, 'resource.write': false, 'user.manage': false, 'license.manage': false },
}

export class ForbiddenError extends Error {
  readonly capability: Capability
  constructor(capability: Capability) {
    super(`forbidden: missing capability '${capability}'`)
    this.name = 'ForbiddenError'
    this.capability = capability
  }
}

export function authorize(user: { role: Role }, action: Capability): boolean {
  return MATRIX[user.role]?.[action] ?? false
}

export function requireCapability(user: Actor, action: Capability): void {
  if (!authorize(user, action)) throw new ForbiddenError(action)
}

export function isRole(v: unknown): v is Role {
  return v === 'admin' || v === 'member' || v === 'viewer'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/auth/authorize.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/auth/authorize.ts apps/control-plane/src/auth/authorize.test.ts
git commit -m "feat(control-plane): authorize() role→capability matrix"
```

---

## Task 3: Password hashing (scrypt) + pglite test helper

**Files:**
- Create: `apps/control-plane/src/auth/password.ts`
- Create: `apps/control-plane/src/test/db.ts` (the shared helper shown in File Structure)
- Test: `apps/control-plane/src/auth/password.test.ts`

**Interfaces:**
- Produces:
  - `async function hashPassword(plaintext: string): Promise<string>` → `scrypt$<saltHex>$<hashHex>`
  - `async function verifyPassword(plaintext: string, stored: string): Promise<boolean>` (timing-safe; `false` on any malformed stored value)
  - `freshDb()` / `seedOrg(db)` test helpers.

- [ ] **Step 1: Create the test helper**

Create `apps/control-plane/src/test/db.ts` exactly as shown in the **File Structure → Testing note** above. Verify the relative path to `packages/schema/drizzle` resolves from `src/test/`:
`apps/control-plane/src/test/` → `../../../../packages/schema/drizzle`.

- [ ] **Step 2: Write the failing test**

`apps/control-plane/src/auth/password.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { hashPassword, verifyPassword } from './password'

describe('password', () => {
  test('hash is salted, prefixed, and not the plaintext', async () => {
    const h = await hashPassword('correct horse battery staple')
    expect(h.startsWith('scrypt$')).toBe(true)
    expect(h).not.toContain('correct horse')
    const h2 = await hashPassword('correct horse battery staple')
    expect(h2).not.toBe(h) // random salt → different digest
  })

  test('verify accepts the right password and rejects the wrong one', async () => {
    const h = await hashPassword('s3cret-pass')
    expect(await verifyPassword('s3cret-pass', h)).toBe(true)
    expect(await verifyPassword('wrong', h)).toBe(false)
  })

  test('verify returns false on malformed stored values instead of throwing', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false)
    expect(await verifyPassword('x', 'scrypt$onlyonepart')).toBe(false)
    expect(await verifyPassword('x', '')).toBe(false)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/auth/password.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the implementation**

`apps/control-plane/src/auth/password.ts`:

```ts
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>

const KEYLEN = 64

export async function hashPassword(plaintext: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = await scryptAsync(plaintext, salt, KEYLEN)
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`
}

export async function verifyPassword(plaintext: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  const salt = Buffer.from(parts[1], 'hex')
  const expected = Buffer.from(parts[2], 'hex')
  if (salt.length !== 16 || expected.length !== KEYLEN) return false
  const derived = await scryptAsync(plaintext, salt, KEYLEN)
  return timingSafeEqual(derived, expected)
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/auth/password.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane/src/auth/password.ts apps/control-plane/src/auth/password.test.ts apps/control-plane/src/test/db.ts
git commit -m "feat(control-plane): scrypt password hashing + pglite test helper"
```

---

## Task 4: Session token codec (HMAC)

**Files:**
- Create: `apps/control-plane/src/auth/session.ts`
- Test: `apps/control-plane/src/auth/session.test.ts`

**Interfaces:**
- Produces:
  - `interface SessionPayload { uid: string; oid: string; role: Role; exp: number }` (`exp` = epoch ms)
  - `function signSession(payload: Omit<SessionPayload, 'exp'>, secret: string, ttlMs: number, nowMs: number): string`
  - `function verifySession(token: string, secret: string, nowMs: number): SessionPayload | null` (null on tamper/expiry/malformed)
- Consumes: `Role` from `./authorize`.
- Note: `nowMs` is injected (no `Date.now()` inside — keeps it deterministically testable).

- [ ] **Step 1: Write the failing test**

`apps/control-plane/src/auth/session.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { signSession, verifySession } from './session'

const SECRET = 'test-secret-please-change'
const base = { uid: 'u1', oid: 'o1', role: 'admin' as const }

describe('session codec', () => {
  test('round-trips a valid token', () => {
    const now = 1_000_000
    const token = signSession(base, SECRET, 60_000, now)
    const out = verifySession(token, SECRET, now + 30_000)
    expect(out).toMatchObject({ uid: 'u1', oid: 'o1', role: 'admin' })
    expect(out?.exp).toBe(now + 60_000)
  })

  test('rejects an expired token', () => {
    const now = 1_000_000
    const token = signSession(base, SECRET, 60_000, now)
    expect(verifySession(token, SECRET, now + 60_001)).toBeNull()
  })

  test('rejects a token signed with a different secret', () => {
    const token = signSession(base, SECRET, 60_000, 0)
    expect(verifySession(token, 'other-secret', 1)).toBeNull()
  })

  test('rejects a tampered payload', () => {
    const token = signSession(base, SECRET, 60_000, 0)
    const [body, sig] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ uid: 'attacker', oid: 'o1', role: 'admin', exp: 9e15 })).toString('base64url')
    expect(verifySession(`${forged}.${sig}`, SECRET, 1)).toBeNull()
    expect(verifySession(`${body}.deadbeef`, SECRET, 1)).toBeNull()
  })

  test('rejects malformed tokens', () => {
    expect(verifySession('', SECRET, 1)).toBeNull()
    expect(verifySession('nodot', SECRET, 1)).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/auth/session.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`apps/control-plane/src/auth/session.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto'
import { isRole, type Role } from './authorize'

export interface SessionPayload {
  uid: string
  oid: string
  role: Role
  exp: number
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url')
}

export function signSession(
  payload: Omit<SessionPayload, 'exp'>,
  secret: string,
  ttlMs: number,
  nowMs: number,
): string {
  const full: SessionPayload = { ...payload, exp: nowMs + ttlMs }
  const body = Buffer.from(JSON.stringify(full)).toString('base64url')
  return `${body}.${sign(body, secret)}`
}

export function verifySession(token: string, secret: string, nowMs: number): SessionPayload | null {
  const dot = token.indexOf('.')
  if (dot <= 0) return null
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = sign(body, secret)
  const sigBuf = Buffer.from(sig)
  const expBuf = Buffer.from(expected)
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const p = parsed as Record<string, unknown>
  if (
    typeof p.uid !== 'string' ||
    typeof p.oid !== 'string' ||
    !isRole(p.role) ||
    typeof p.exp !== 'number'
  ) {
    return null
  }
  if (nowMs >= p.exp) return null
  return { uid: p.uid, oid: p.oid, role: p.role as Role, exp: p.exp }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/auth/session.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/auth/session.ts apps/control-plane/src/auth/session.test.ts
git commit -m "feat(control-plane): HMAC-signed session token codec"
```

---

## Task 5: Schema migration — `user.status`

**Files:**
- Modify: `packages/schema/src/schema.ts` (add `status` to `user`)
- Modify: `packages/schema/src/enums.ts` (add `USER_ROLES`, `USER_STATUS`)
- Create: `packages/schema/drizzle/0002_*.sql` + `drizzle/meta/*` (generated)
- Test: `packages/schema/test/schema.test.ts` (add a case)

**Interfaces:**
- Produces: `user.status` column (`active` | `deactivated`, default `active`); `USER_ROLES = ['admin','member','viewer']`; `USER_STATUS = ['active','deactivated']`.
- Consumed by: `auth-service.ts` (Task 7), `seed.ts` (Task 7).

- [ ] **Step 1: Write the failing test**

Add to `packages/schema/test/schema.test.ts` (inside the `describe('schema', ...)` block):

```ts
test('user.status defaults to active and accepts deactivated', async () => {
  const db = await freshMigratedDb()
  const [o] = await db.insert(schema.org).values({ name: 'o' }).returning()
  const [u1] = await db.insert(schema.user).values({
    orgId: o.id, email: 'a@x.io', passwordHash: 'scrypt$aa$bb', role: 'admin',
  }).returning()
  expect(u1.status).toBe('active')
  const [u2] = await db.insert(schema.user).values({
    orgId: o.id, email: 'b@x.io', passwordHash: 'scrypt$aa$bb', role: 'viewer', status: 'deactivated',
  }).returning()
  expect(u2.status).toBe('deactivated')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @metamodels/schema exec vitest run test/schema.test.ts`
Expected: FAIL — `status` does not exist on the insert type / column missing.

- [ ] **Step 3: Add the column and enums**

In `packages/schema/src/schema.ts`, add `status` to the `user` table (after `role`):

```ts
export const user = pgTable('user', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('admin'),
  status: text('status').notNull().default('active'),
  createdAt: createdAt(),
})
```

In `packages/schema/src/enums.ts`, add:

```ts
export const USER_ROLES = ['admin', 'member', 'viewer'] as const
export const USER_STATUS = ['active', 'deactivated'] as const

export type UserRole = (typeof USER_ROLES)[number]
export type UserStatus = (typeof USER_STATUS)[number]
```

- [ ] **Step 4: Generate the migration**

Run:
```bash
pnpm --filter @metamodels/schema exec drizzle-kit generate
```
Expected: creates `packages/schema/drizzle/0002_*.sql` containing `ALTER TABLE "user" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;` and updates `drizzle/meta/`. **Do not hand-edit; inspect it** to confirm it is purely additive (only the `ADD COLUMN`), then stage it.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @metamodels/schema exec vitest run test/schema.test.ts`
Expected: PASS (existing + new case).

- [ ] **Step 6: Commit**

```bash
git add packages/schema/src/schema.ts packages/schema/src/enums.ts packages/schema/drizzle packages/schema/test/schema.test.ts
git commit -m "feat(schema): add user.status column (active|deactivated) + user enums"
```

---

## Task 6: DB singleton, audit writer, and RSC guard glue

**Files:**
- Create: `apps/control-plane/src/server/db.ts`
- Create: `apps/control-plane/src/server/audit.ts`
- Create: `apps/control-plane/src/server/current-user.ts`
- Create: `apps/control-plane/src/server/guard.ts`
- Test: `apps/control-plane/src/server/audit.test.ts`

**Interfaces:**
- Produces:
  - `getDb(): Db` (memoized Drizzle Postgres from `DATABASE_URL`)
  - `type Db = PgDatabase<any, any, typeof schema>`
  - `async function writeAudit(db, entry: { orgId: string; actor: string; action: string; target: string; detail?: unknown }): Promise<void>`
  - `SESSION_COOKIE = 'mm_session'`; `SESSION_TTL_MS = 12h`
  - `async function getCurrentActor(): Promise<Actor | null>` (Next glue: reads cookie via `next/headers`)
  - `async function setSessionCookie(actor: Actor): Promise<void>` / `clearSessionCookie()`
  - `async function requireUser(): Promise<Actor>` (redirects to `/login` if none)
  - `async function requireCapabilityOr403(action: Capability): Promise<Actor>`
- Consumes: `verifySession`/`signSession` (Task 4), `authorize`/`Actor` (Task 2), `getDb` + `user` table.

- [ ] **Step 1: Write the failing test (audit writer only — the Next-glue files are gated by build)**

`apps/control-plane/src/server/audit.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '@metamodels/schema'
import { freshDb, seedOrg } from '../test/db'
import { writeAudit } from './audit'

describe('writeAudit', () => {
  test('persists an org-scoped audit row with actor/action/target/detail', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    await writeAudit(db, {
      orgId: o.id, actor: 'admin@x.io', action: 'flock.create',
      target: 'flock:123', detail: { name: 'local-ollama' },
    })
    const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, o.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor: 'admin@x.io', action: 'flock.create', target: 'flock:123' })
    expect(rows[0].detail).toMatchObject({ name: 'local-ollama' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/audit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `db.ts` and `audit.ts`**

`apps/control-plane/src/server/db.ts`:

```ts
import { drizzle } from 'drizzle-orm/postgres-js'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import postgres from 'postgres'
import * as schema from '@metamodels/schema'

export type Db = PgDatabase<any, any, any>

let cached: Db | undefined

export function getDb(): Db {
  if (cached) return cached
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required')
  cached = drizzle(postgres(url), { schema })
  return cached
}
```

`apps/control-plane/src/server/audit.ts`:

```ts
import { auditLog } from '@metamodels/schema'
import type { Db } from './db'

export interface AuditEntry {
  orgId: string
  actor: string
  action: string
  target: string
  detail?: unknown
}

export async function writeAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    orgId: entry.orgId,
    actor: entry.actor,
    action: entry.action,
    target: entry.target,
    detail: (entry.detail ?? null) as never,
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/audit.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Implement the Next-glue files (`current-user.ts`, `guard.ts`)**

`apps/control-plane/src/server/current-user.ts`:

```ts
import { cookies } from 'next/headers'
import { eq } from 'drizzle-orm'
import { user } from '@metamodels/schema'
import { signSession, verifySession } from '../auth/session'
import { isRole, type Actor } from '../auth/authorize'
import { getDb } from './db'

export const SESSION_COOKIE = 'mm_session'
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000

function secret(): string {
  const s = process.env.SESSION_SECRET
  if (!s || s.length < 16) throw new Error('SESSION_SECRET must be set (>=16 chars)')
  return s
}

export async function getCurrentActor(): Promise<Actor | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value
  if (!token) return null
  const payload = verifySession(token, secret(), Date.now())
  if (!payload) return null
  // Re-load the user so a deactivated/role-changed user loses access immediately.
  const rows = await getDb().select().from(user).where(eq(user.id, payload.uid)).limit(1)
  const u = rows[0]
  if (!u || u.status !== 'active' || !isRole(u.role)) return null
  return { id: u.id, orgId: u.orgId, email: u.email, role: u.role }
}

export async function setSessionCookie(actor: Actor): Promise<void> {
  const token = signSession(
    { uid: actor.id, oid: actor.orgId, role: actor.role },
    secret(),
    SESSION_TTL_MS,
    Date.now(),
  )
  ;(await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  })
}

export async function clearSessionCookie(): Promise<void> {
  ;(await cookies()).delete(SESSION_COOKIE)
}
```

`apps/control-plane/src/server/guard.ts`:

```ts
import { redirect } from 'next/navigation'
import { authorize, type Actor, type Capability } from '../auth/authorize'
import { getCurrentActor } from './current-user'

export async function requireUser(): Promise<Actor> {
  const actor = await getCurrentActor()
  if (!actor) redirect('/login')
  return actor
}

export async function requireCapabilityOr403(action: Capability): Promise<Actor> {
  const actor = await requireUser()
  if (!authorize(actor, action)) redirect('/(app)?forbidden=1')
  return actor
}
```

- [ ] **Step 6: Verify build + typecheck**

Run:
```bash
pnpm --filter @metamodels/control-plane exec tsc --noEmit && pnpm --filter @metamodels/control-plane exec vitest run src/server/audit.test.ts
```
Expected: no type errors; audit test PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/control-plane/src/server/db.ts apps/control-plane/src/server/audit.ts apps/control-plane/src/server/current-user.ts apps/control-plane/src/server/guard.ts apps/control-plane/src/server/audit.test.ts
git commit -m "feat(control-plane): db singleton, audit writer, session cookie + RSC guards"
```

---

## Task 7: Admin seed + login verification service

**Files:**
- Create: `apps/control-plane/src/server/seed.ts`
- Create: `apps/control-plane/src/server/auth-service.ts`
- Create: `apps/control-plane/src/auth/login-throttle.ts`
- Create: `apps/control-plane/bin/seed.ts`
- Test: `apps/control-plane/src/server/seed.test.ts`, `apps/control-plane/src/server/auth-service.test.ts`, `apps/control-plane/src/auth/login-throttle.test.ts`

**Interfaces:**
- Produces:
  - `async function seedAdmin(db, opts: { email: string; password: string; orgName?: string }): Promise<{ created: boolean; actor: Actor }>` (idempotent: if a user with that email exists, returns `created: false` without touching it)
  - `type LoginResult = { ok: true; actor: Actor } | { ok: false; reason: 'invalid' | 'deactivated' }`
  - `async function verifyLogin(db, email: string, password: string): Promise<LoginResult>`
  - `class LoginThrottle { check(ip: string, nowMs: number): boolean; record(ip: string, nowMs: number): void }` (max 5 failures / 15 min window)
- Consumes: `hashPassword`/`verifyPassword` (Task 3), `Actor` (Task 2), `user`/`org` tables.

- [ ] **Step 1: Write the failing tests**

`apps/control-plane/src/auth/login-throttle.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { LoginThrottle } from './login-throttle'

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

`apps/control-plane/src/server/seed.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import * as schema from '@metamodels/schema'
import { freshDb } from '../test/db'
import { seedAdmin } from './seed'
import { verifyPassword } from '../auth/password'

describe('seedAdmin', () => {
  test('creates an org + active admin whose password verifies', async () => {
    const db = await freshDb()
    const r = await seedAdmin(db, { email: 'admin@x.io', password: 'hunter2hunter2', orgName: 'Acme' })
    expect(r.created).toBe(true)
    expect(r.actor.role).toBe('admin')
    const [u] = await db.select().from(schema.user)
    expect(u.status).toBe('active')
    expect(await verifyPassword('hunter2hunter2', u.passwordHash)).toBe(true)
  })

  test('is idempotent — second call does not create or mutate', async () => {
    const db = await freshDb()
    await seedAdmin(db, { email: 'admin@x.io', password: 'hunter2hunter2' })
    const r2 = await seedAdmin(db, { email: 'admin@x.io', password: 'DIFFERENT-pass' })
    expect(r2.created).toBe(false)
    const users = await db.select().from(schema.user)
    expect(users).toHaveLength(1)
    expect(await verifyPassword('hunter2hunter2', users[0].passwordHash)).toBe(true) // unchanged
  })
})
```

`apps/control-plane/src/server/auth-service.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '@metamodels/schema'
import { freshDb } from '../test/db'
import { seedAdmin } from './seed'
import { verifyLogin } from './auth-service'

describe('verifyLogin', () => {
  test('accepts correct credentials for an active user', async () => {
    const db = await freshDb()
    await seedAdmin(db, { email: 'admin@x.io', password: 'hunter2hunter2' })
    const r = await verifyLogin(db, 'admin@x.io', 'hunter2hunter2')
    expect(r).toMatchObject({ ok: true })
    if (r.ok) expect(r.actor.email).toBe('admin@x.io')
  })

  test('rejects wrong password and unknown email as generic invalid', async () => {
    const db = await freshDb()
    await seedAdmin(db, { email: 'admin@x.io', password: 'hunter2hunter2' })
    expect(await verifyLogin(db, 'admin@x.io', 'nope')).toEqual({ ok: false, reason: 'invalid' })
    expect(await verifyLogin(db, 'ghost@x.io', 'whatever')).toEqual({ ok: false, reason: 'invalid' })
  })

  test('rejects a deactivated user distinctly', async () => {
    const db = await freshDb()
    await seedAdmin(db, { email: 'admin@x.io', password: 'hunter2hunter2' })
    await db.update(schema.user).set({ status: 'deactivated' }).where(eq(schema.user.email, 'admin@x.io'))
    expect(await verifyLogin(db, 'admin@x.io', 'hunter2hunter2')).toEqual({ ok: false, reason: 'deactivated' })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/auth/login-throttle.test.ts src/server/seed.test.ts src/server/auth-service.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the modules**

`apps/control-plane/src/auth/login-throttle.ts`:

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

`apps/control-plane/src/server/seed.ts`:

```ts
import { eq } from 'drizzle-orm'
import { org, user } from '@metamodels/schema'
import type { Db } from './db'
import type { Actor } from '../auth/authorize'
import { hashPassword } from '../auth/password'

export interface SeedOpts { email: string; password: string; orgName?: string }
export interface SeedResult { created: boolean; actor: Actor }

export async function seedAdmin(db: Db, opts: SeedOpts): Promise<SeedResult> {
  const existing = await db.select().from(user).where(eq(user.email, opts.email)).limit(1)
  if (existing[0]) {
    const u = existing[0]
    return { created: false, actor: { id: u.id, orgId: u.orgId, email: u.email, role: 'admin' } }
  }
  // Reuse an existing org (single-org instance) or create one.
  const orgs = await db.select().from(org).limit(1)
  const orgId = orgs[0]?.id ?? (await db.insert(org).values({ name: opts.orgName ?? 'default' }).returning())[0].id
  const passwordHash = await hashPassword(opts.password)
  const [u] = await db.insert(user).values({
    orgId, email: opts.email, passwordHash, role: 'admin', status: 'active',
  }).returning()
  return { created: true, actor: { id: u.id, orgId: u.orgId, email: u.email, role: 'admin' } }
}
```

`apps/control-plane/src/server/auth-service.ts`:

```ts
import { eq } from 'drizzle-orm'
import { user } from '@metamodels/schema'
import type { Db } from './db'
import { isRole, type Actor } from '../auth/authorize'
import { verifyPassword } from '../auth/password'

export type LoginResult =
  | { ok: true; actor: Actor }
  | { ok: false; reason: 'invalid' | 'deactivated' }

export async function verifyLogin(db: Db, email: string, password: string): Promise<LoginResult> {
  const rows = await db.select().from(user).where(eq(user.email, email)).limit(1)
  const u = rows[0]
  if (!u) return { ok: false, reason: 'invalid' }
  const passwordOk = await verifyPassword(password, u.passwordHash)
  if (!passwordOk) return { ok: false, reason: 'invalid' }
  if (u.status !== 'active') return { ok: false, reason: 'deactivated' }
  if (!isRole(u.role)) return { ok: false, reason: 'invalid' }
  return { ok: true, actor: { id: u.id, orgId: u.orgId, email: u.email, role: u.role } }
}
```

`apps/control-plane/bin/seed.ts`:

```ts
import { getDb } from '../src/server/db'
import { seedAdmin } from '../src/server/seed'

async function main() {
  const email = process.env.OPERATOR_EMAIL
  const password = process.env.OPERATOR_PASSWORD
  if (!email || !password) {
    console.error('Set OPERATOR_EMAIL and OPERATOR_PASSWORD to seed the first admin.')
    process.exit(1)
  }
  const r = await seedAdmin(getDb(), { email, password })
  console.log(r.created ? `Seeded admin ${email}` : `Admin ${email} already exists — no change.`)
  process.exit(0)
}

void main()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/auth/login-throttle.test.ts src/server/seed.test.ts src/server/auth-service.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/server/seed.ts apps/control-plane/src/server/auth-service.ts apps/control-plane/src/auth/login-throttle.ts apps/control-plane/bin/seed.ts apps/control-plane/src/server/seed.test.ts apps/control-plane/src/server/auth-service.test.ts apps/control-plane/src/auth/login-throttle.test.ts
git commit -m "feat(control-plane): admin seed + login verification service + login throttle"
```

---

## Task 8: Flocks Zod schema + service (list / save / delete)

**Files:**
- Create: `apps/control-plane/src/lib/flock-schema.ts`
- Create: `apps/control-plane/src/server/flocks-service.ts`
- Test: `apps/control-plane/src/server/flocks-service.test.ts`

**Interfaces:**
- Produces:
  - `saveFlockInput` Zod schema → `SaveFlockInput = { id?: string; breed: 'ollama' | 'comfyui'; name: string; baseUrl: string; upstreamAuth?: string | null; tlsTrust: boolean }`
  - `async function listFlocks(db, actor): Promise<Flock[]>` (org-scoped; requires `read`)
  - `async function saveFlock(db, actor, input: unknown): Promise<Flock>` (requires `resource.write`; insert if no `id`, else update **within actor.orgId**; audits `flock.create`/`flock.update`)
  - `async function deleteFlock(db, actor, id: string): Promise<void>` (requires `resource.write`; org-scoped; audits `flock.delete`)
  - `class NotFoundError extends Error`
- Consumes: `Actor`/`requireCapability`/`ForbiddenError` (Task 2), `writeAudit` (Task 6), `flock` table, `BREED_IDS`.
- **Org-scope rule (the reusable pattern):** every query filters by `eq(flock.orgId, actor.orgId)`; update/delete match **both** `id` and `orgId` so no cross-org mutation is possible.

- [ ] **Step 1: Write the failing test**

`apps/control-plane/src/server/flocks-service.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '@metamodels/schema'
import { freshDb, seedOrg } from '../test/db'
import { listFlocks, saveFlock, deleteFlock, NotFoundError } from './flocks-service'
import { ForbiddenError, type Actor } from '../auth/authorize'

async function actorFor(db: Awaited<ReturnType<typeof freshDb>>, role: Actor['role']): Promise<Actor> {
  const o = await seedOrg(db)
  return { id: 'u1', orgId: o.id, email: `${role}@x.io`, role }
}

describe('flocks-service', () => {
  test('member can create a flock; it is org-scoped and audited', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'member')
    const f = await saveFlock(db, actor, {
      breed: 'ollama', name: 'local', baseUrl: 'http://localhost:11434', tlsTrust: false,
    })
    expect(f.orgId).toBe(actor.orgId)
    expect(f.name).toBe('local')
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'flock.create'))
    expect(audits).toHaveLength(1)
    expect(audits[0].actor).toBe('member@x.io')
  })

  test('viewer cannot create (ForbiddenError) and nothing is written', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'viewer')
    await expect(saveFlock(db, actor, {
      breed: 'ollama', name: 'x', baseUrl: 'http://x', tlsTrust: false,
    })).rejects.toThrow(ForbiddenError)
    expect(await db.select().from(schema.flock)).toHaveLength(0)
  })

  test('save with id updates within the org; list returns only this org', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    const created = await saveFlock(db, actor, { breed: 'ollama', name: 'a', baseUrl: 'http://a', tlsTrust: false })
    const updated = await saveFlock(db, actor, { id: created.id, breed: 'ollama', name: 'a2', baseUrl: 'http://a', tlsTrust: true })
    expect(updated.id).toBe(created.id)
    expect(updated.name).toBe('a2')
    expect(updated.tlsTrust).toBe(true)
    const list = await listFlocks(db, actor)
    expect(list).toHaveLength(1)
  })

  test('cannot update or delete a flock in another org', async () => {
    const db = await freshDb()
    const mine = await actorFor(db, 'admin')
    const [otherOrg] = await db.insert(schema.org).values({ name: 'other' }).returning()
    const [foreign] = await db.insert(schema.flock).values({
      orgId: otherOrg.id, breed: 'ollama', name: 'foreign', baseUrl: 'http://f',
    }).returning()
    await expect(saveFlock(db, mine, { id: foreign.id, breed: 'ollama', name: 'hijack', baseUrl: 'http://f', tlsTrust: false }))
      .rejects.toThrow(NotFoundError)
    await expect(deleteFlock(db, mine, foreign.id)).rejects.toThrow(NotFoundError)
    // foreign flock untouched
    const [still] = await db.select().from(schema.flock).where(eq(schema.flock.id, foreign.id))
    expect(still.name).toBe('foreign')
  })

  test('invalid input is rejected before any write', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    await expect(saveFlock(db, actor, { breed: 'notabreed', name: '', baseUrl: 'nota url', tlsTrust: false }))
      .rejects.toThrow()
    expect(await db.select().from(schema.flock)).toHaveLength(0)
  })

  test('delete removes an org flock and audits it', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    const f = await saveFlock(db, actor, { breed: 'ollama', name: 'gone', baseUrl: 'http://g', tlsTrust: false })
    await deleteFlock(db, actor, f.id)
    expect(await db.select().from(schema.flock)).toHaveLength(0)
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'flock.delete'))
    expect(audits).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/flocks-service.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement schema + service**

`apps/control-plane/src/lib/flock-schema.ts`:

```ts
import { z } from 'zod'
import { BREED_IDS } from '@metamodels/schema'

export const saveFlockInput = z.object({
  id: z.string().uuid().optional(),
  breed: z.enum(BREED_IDS),
  name: z.string().trim().min(1).max(120),
  baseUrl: z.string().url(),
  upstreamAuth: z.string().trim().min(1).nullish(),
  tlsTrust: z.boolean(),
})

export type SaveFlockInput = z.infer<typeof saveFlockInput>

export const flockConnectionInput = saveFlockInput.pick({
  breed: true, baseUrl: true, upstreamAuth: true, tlsTrust: true,
})
export type FlockConnectionInput = z.infer<typeof flockConnectionInput>
```

`apps/control-plane/src/server/flocks-service.ts`:

```ts
import { and, eq } from 'drizzle-orm'
import { flock, type Flock } from '@metamodels/schema'
import type { Db } from './db'
import { requireCapability, type Actor } from '../auth/authorize'
import { writeAudit } from './audit'
import { saveFlockInput } from '../lib/flock-schema'

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`not found: ${what}`)
    this.name = 'NotFoundError'
  }
}

export async function listFlocks(db: Db, actor: Actor): Promise<Flock[]> {
  requireCapability(actor, 'read')
  return db.select().from(flock).where(eq(flock.orgId, actor.orgId))
}

export async function saveFlock(db: Db, actor: Actor, input: unknown): Promise<Flock> {
  requireCapability(actor, 'resource.write')
  const data = saveFlockInput.parse(input)
  const values = {
    breed: data.breed,
    name: data.name,
    baseUrl: data.baseUrl,
    upstreamAuth: data.upstreamAuth ?? null,
    tlsTrust: data.tlsTrust,
  }

  if (data.id) {
    const [updated] = await db
      .update(flock)
      .set(values)
      .where(and(eq(flock.id, data.id), eq(flock.orgId, actor.orgId)))
      .returning()
    if (!updated) throw new NotFoundError(`flock ${data.id}`)
    await writeAudit(db, {
      orgId: actor.orgId, actor: actor.email, action: 'flock.update',
      target: `flock:${updated.id}`, detail: { name: updated.name },
    })
    return updated
  }

  const [created] = await db.insert(flock).values({ orgId: actor.orgId, ...values }).returning()
  await writeAudit(db, {
    orgId: actor.orgId, actor: actor.email, action: 'flock.create',
    target: `flock:${created.id}`, detail: { name: created.name, breed: created.breed },
  })
  return created
}

export async function deleteFlock(db: Db, actor: Actor, id: string): Promise<void> {
  requireCapability(actor, 'resource.write')
  const [deleted] = await db
    .delete(flock)
    .where(and(eq(flock.id, id), eq(flock.orgId, actor.orgId)))
    .returning()
  if (!deleted) throw new NotFoundError(`flock ${id}`)
  await writeAudit(db, {
    orgId: actor.orgId, actor: actor.email, action: 'flock.delete', target: `flock:${id}`,
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/flocks-service.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/lib/flock-schema.ts apps/control-plane/src/server/flocks-service.ts apps/control-plane/src/server/flocks-service.test.ts
git commit -m "feat(control-plane): flocks service (Zod→authorize→org-scope→audit) — the reusable CRUD pattern"
```

---

## Task 9: Flock Test-connection service

**Files:**
- Create: `apps/control-plane/src/server/flock-health.ts`
- Test: `apps/control-plane/src/server/flock-health.test.ts`

**Interfaces:**
- Produces:
  - `function buildBreedRegistry(): BreedRegistry` (wraps `@metamodels/connectors` ollama+comfyui — mirrors data-plane `breeds.ts`)
  - `async function testFlockConnection(registry, input: unknown): Promise<{ ok: boolean; detail?: string }>` (validates via `flockConnectionInput`, dispatches to `breed.health`)
- Consumes: `flockConnectionInput` (Task 8), `BreedRegistry`/breeds from connectors.
- Test note: stub `global.fetch` (health uses global `fetch`); ollama hits `/api/version`, comfyui hits `/system_stats`.

- [ ] **Step 1: Write the failing test**

`apps/control-plane/src/server/flock-health.test.ts`:

```ts
import { afterEach, describe, expect, test, vi } from 'vitest'
import { buildBreedRegistry, testFlockConnection } from './flock-health'

const registry = buildBreedRegistry()

afterEach(() => { vi.unstubAllGlobals() })

describe('testFlockConnection', () => {
  test('returns ok when the ollama upstream answers /api/version', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(String(url)).toBe('http://localhost:11434/api/version')
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await testFlockConnection(registry, {
      breed: 'ollama', baseUrl: 'http://localhost:11434/', tlsTrust: false,
    })
    expect(r.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  test('returns ok:false with detail when the upstream is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    const r = await testFlockConnection(registry, {
      breed: 'comfyui', baseUrl: 'http://localhost:8188', tlsTrust: false,
    })
    expect(r.ok).toBe(false)
    expect(r.detail).toContain('ECONNREFUSED')
  })

  test('rejects an invalid breed before dispatching', async () => {
    await expect(testFlockConnection(registry, { breed: 'bogus', baseUrl: 'http://x', tlsTrust: false }))
      .rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/flock-health.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`apps/control-plane/src/server/flock-health.ts`:

```ts
import { BreedRegistry, comfyuiBreed, ollamaBreed } from '@metamodels/connectors'
import { flockConnectionInput } from '../lib/flock-schema'

export function buildBreedRegistry(): BreedRegistry {
  const registry = new BreedRegistry()
  registry.register(ollamaBreed)
  registry.register(comfyuiBreed)
  return registry
}

export async function testFlockConnection(
  registry: BreedRegistry,
  input: unknown,
): Promise<{ ok: boolean; detail?: string }> {
  const data = flockConnectionInput.parse(input)
  const breed = registry.get(data.breed)
  return breed.health({
    baseUrl: data.baseUrl,
    upstreamAuth: data.upstreamAuth ?? null,
    tlsTrust: data.tlsTrust,
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/flock-health.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/server/flock-health.ts apps/control-plane/src/server/flock-health.test.ts
git commit -m "feat(control-plane): flock test-connection via breed.health"
```

---

## Task 10: Role-based nav model + UI primitives

**Files:**
- Create: `apps/control-plane/src/auth/nav.ts`
- Create: `apps/control-plane/src/components/ui/button.tsx`, `input.tsx`, `label.tsx`, `select.tsx`, `switch.tsx`, `status-pill.tsx`, `breed-chip.tsx`, `drawer.tsx`, `data-table.tsx`
- Create: `apps/control-plane/src/components/app-sidebar.tsx`, `src/components/page-header.tsx`
- Test: `apps/control-plane/src/auth/nav.test.ts`

**Interfaces:**
- Produces:
  - `interface NavItem { href: string; label: string; capability: Capability }`
  - `function navItemsForRole(role: Role): NavItem[]` (viewer sees Dashboard/Usage/Audit only; member adds Flocks/Paddocks/Keys; admin adds Team/Settings — future routes present but only Flocks is live in 5.1)
  - Presentational primitives (props typed; no logic).
- Consumes: `Role`/`Capability`/`authorize` (Task 2), `cn` (Task 1).

- [ ] **Step 1: Write the failing test**

`apps/control-plane/src/auth/nav.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { navItemsForRole } from './nav'

describe('navItemsForRole', () => {
  test('viewer sees only read surfaces (no Flocks/Team)', () => {
    const labels = navItemsForRole('viewer').map((i) => i.label)
    expect(labels).toContain('Dashboard')
    expect(labels).toContain('Usage')
    expect(labels).toContain('Audit')
    expect(labels).not.toContain('Flocks')
    expect(labels).not.toContain('Team')
  })

  test('member sees resource surfaces but not Team/Settings', () => {
    const labels = navItemsForRole('member').map((i) => i.label)
    expect(labels).toContain('Flocks')
    expect(labels).not.toContain('Team')
    expect(labels).not.toContain('Settings')
  })

  test('admin sees everything including Team and Settings', () => {
    const labels = navItemsForRole('admin').map((i) => i.label)
    expect(labels).toContain('Flocks')
    expect(labels).toContain('Team')
    expect(labels).toContain('Settings')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/auth/nav.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the nav model**

`apps/control-plane/src/auth/nav.ts`:

```ts
import { authorize, type Capability, type Role } from './authorize'

export interface NavItem {
  href: string
  label: string
  capability: Capability
}

const ALL_ITEMS: NavItem[] = [
  { href: '/', label: 'Dashboard', capability: 'read' },
  { href: '/flocks', label: 'Flocks', capability: 'resource.write' },
  { href: '/paddocks', label: 'Paddocks', capability: 'resource.write' },
  { href: '/keys', label: 'API Keys', capability: 'resource.write' },
  { href: '/usage', label: 'Usage', capability: 'read' },
  { href: '/audit', label: 'Audit', capability: 'read' },
  { href: '/team', label: 'Team', capability: 'user.manage' },
  { href: '/settings', label: 'Settings', capability: 'license.manage' },
]

export function navItemsForRole(role: Role): NavItem[] {
  return ALL_ITEMS.filter((i) => authorize({ role }, i.capability))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/auth/nav.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Implement the primitives (thin, presentational — gated by build)**

`apps/control-plane/src/components/ui/button.tsx`:

```tsx
import { cn } from './cn'
import type { ButtonHTMLAttributes } from 'react'

type Variant = 'primary' | 'ghost' | 'danger'

export function Button({
  variant = 'primary', className, ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const styles: Record<Variant, string> = {
    primary: 'bg-[var(--color-primary)] text-[var(--color-on-primary)] hover:opacity-90',
    ghost: 'bg-transparent text-[var(--color-text)] border border-[var(--color-border)] hover:bg-[var(--color-panel-2)]',
    danger: 'bg-transparent text-[var(--color-danger)] border border-[var(--color-danger)] hover:bg-[var(--color-danger)]/10',
  }
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center rounded-[var(--radius-control)] px-3 py-2 text-sm font-medium transition disabled:opacity-50',
        styles[variant], className,
      )}
      {...props}
    />
  )
}
```

`apps/control-plane/src/components/ui/input.tsx`:

```tsx
import { cn } from './cn'
import type { InputHTMLAttributes } from 'react'

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'w-full rounded-[var(--radius-control)] border border-[var(--color-input-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm text-[var(--color-text)] placeholder:text-[var(--color-faint)] focus:border-[var(--color-primary)] focus:outline-none',
        className,
      )}
      {...props}
    />
  )
}
```

`apps/control-plane/src/components/ui/label.tsx`:

```tsx
import { cn } from './cn'
import type { LabelHTMLAttributes } from 'react'

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('mb-1 block text-xs font-medium text-[var(--color-muted)]', className)} {...props} />
}
```

`apps/control-plane/src/components/ui/select.tsx`:

```tsx
import { cn } from './cn'
import type { SelectHTMLAttributes } from 'react'

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'w-full rounded-[var(--radius-control)] border border-[var(--color-input-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none',
        className,
      )}
      {...props}
    />
  )
}
```

`apps/control-plane/src/components/ui/switch.tsx`:

```tsx
'use client'
import { cn } from './cn'

export function Switch({ checked, onChange, name }: { checked: boolean; onChange: (v: boolean) => void; name?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 items-center rounded-full transition',
        checked ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-border)]',
      )}
    >
      <span className={cn('inline-block h-4 w-4 transform rounded-full bg-[var(--color-bg)] transition', checked ? 'translate-x-4' : 'translate-x-1')} />
      {name && <input type="hidden" name={name} value={checked ? 'true' : 'false'} />}
    </button>
  )
}
```

`apps/control-plane/src/components/ui/status-pill.tsx`:

```tsx
import { cn } from './cn'

export function StatusPill({ ok, labels = ['Healthy', 'Down'] }: { ok: boolean | null; labels?: [string, string] }) {
  const text = ok === null ? 'Unknown' : ok ? labels[0] : labels[1]
  return (
    <span className={cn(
      'inline-flex items-center gap-1 rounded-[var(--radius-chip)] px-2 py-0.5 text-xs font-medium',
      ok === null ? 'text-[var(--color-muted)] bg-[var(--color-panel-2)]'
        : ok ? 'text-[var(--color-primary)] bg-[var(--color-primary)]/10'
          : 'text-[var(--color-danger)] bg-[var(--color-danger)]/10',
    )}>
      {text}
    </span>
  )
}
```

`apps/control-plane/src/components/ui/breed-chip.tsx`:

```tsx
import { cn } from './cn'

export function BreedChip({ breed }: { breed: string }) {
  const isComfy = breed === 'comfyui'
  return (
    <span className={cn(
      'inline-flex rounded-[var(--radius-chip)] px-2 py-0.5 font-mono text-xs',
      isComfy ? 'text-[var(--color-comfyui)] bg-[var(--color-comfyui)]/10' : 'text-[var(--color-primary)] bg-[var(--color-primary)]/10',
    )}>
      {breed}
    </span>
  )
}
```

`apps/control-plane/src/components/ui/drawer.tsx`:

```tsx
'use client'
import type { ReactNode } from 'react'
import { cn } from './cn'

export function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className={cn('absolute right-0 top-0 h-full w-[420px] overflow-y-auto border-l border-[var(--color-border)] bg-[var(--color-panel)] p-6')}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-[var(--color-text)]">{title}</h2>
          <button onClick={onClose} className="text-[var(--color-muted)] hover:text-[var(--color-text)]">✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}
```

`apps/control-plane/src/components/ui/data-table.tsx`:

```tsx
import type { ReactNode } from 'react'

export function DataTable({ headers, children }: { headers: string[]; children: ReactNode }) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-[var(--color-border)] text-left text-xs text-[var(--color-muted)]">
          {headers.map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  )
}
```

`apps/control-plane/src/components/page-header.tsx`:

```tsx
import type { ReactNode } from 'react'

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex items-start justify-between">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-text)]">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-[var(--color-muted)]">{subtitle}</p>}
      </div>
      {actions}
    </div>
  )
}
```

`apps/control-plane/src/components/app-sidebar.tsx`:

```tsx
import Link from 'next/link'
import { navItemsForRole } from '../auth/nav'
import type { Role } from '../auth/authorize'

export function AppSidebar({ role, email }: { role: Role; email: string }) {
  const items = navItemsForRole(role)
  return (
    <aside className="flex w-[228px] flex-col border-r border-[var(--color-border)] bg-[var(--color-panel)] p-4">
      <div className="mb-6 px-2 font-mono text-sm font-semibold text-[var(--color-primary)]">MetaModels</div>
      <nav className="flex flex-col gap-1">
        {items.map((i) => (
          <Link key={i.href} href={i.href} className="rounded-[var(--radius-control)] px-3 py-2 text-sm text-[var(--color-text)] hover:bg-[var(--color-panel-2)]">
            {i.label}
          </Link>
        ))}
      </nav>
      <div className="mt-auto px-2 pt-4 text-xs text-[var(--color-faint)]">
        <div className="truncate">{email}</div>
        <div className="uppercase">{role}</div>
      </div>
    </aside>
  )
}
```

- [ ] **Step 6: Verify typecheck + nav test**

Run:
```bash
pnpm --filter @metamodels/control-plane exec tsc --noEmit && pnpm --filter @metamodels/control-plane exec vitest run src/auth/nav.test.ts
```
Expected: no type errors; nav test PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/control-plane/src/auth/nav.ts apps/control-plane/src/auth/nav.test.ts apps/control-plane/src/components
git commit -m "feat(control-plane): role-based nav model + hand-authored UI primitives + shell chrome"
```

---

## Task 11: Login screen + app shell wiring

**Files:**
- Create: `apps/control-plane/src/app/login/page.tsx`, `apps/control-plane/src/app/login/actions.ts`
- Modify: `apps/control-plane/src/app/(app)/layout.tsx` (authed shell)
- Modify: `apps/control-plane/src/app/(app)/page.tsx` (greet actor)

**Interfaces:**
- Consumes: `verifyLogin` (Task 7), `LoginThrottle` (Task 7), `setSessionCookie`/`clearSessionCookie`/`getCurrentActor` (Task 6), `requireUser` (Task 6), `AppSidebar` (Task 10), `getDb` (Task 6).
- Produces: working login → cookie → protected `(app)` shell → logout.
- This task is thin glue verified by build + typecheck + a manual smoke note (no new unit test; logic is already covered in Tasks 6–10).

- [ ] **Step 1: Implement the login server actions**

`apps/control-plane/src/app/login/actions.ts`:

```ts
'use server'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getDb } from '../../server/db'
import { verifyLogin } from '../../server/auth-service'
import { setSessionCookie, clearSessionCookie } from '../../server/current-user'
import { LoginThrottle } from '../../auth/login-throttle'

// Module-scoped throttle (per server instance). Good enough for a self-hosted single node.
const throttle = new LoginThrottle()

export async function login(_prev: unknown, formData: FormData): Promise<{ error?: string }> {
  const email = String(formData.get('email') ?? '').trim()
  const password = String(formData.get('password') ?? '')
  const ip = (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local'
  const now = Date.now()

  if (!throttle.check(ip, now)) return { error: 'Too many attempts. Try again later.' }

  const result = await verifyLogin(getDb(), email, password)
  if (!result.ok) {
    throttle.record(ip, now)
    return { error: result.reason === 'deactivated' ? 'This account is deactivated.' : 'Invalid email or password.' }
  }
  await setSessionCookie(result.actor)
  redirect('/')
}

export async function logout(): Promise<void> {
  await clearSessionCookie()
  redirect('/login')
}
```

`apps/control-plane/src/app/login/page.tsx`:

```tsx
'use client'
import { useActionState } from 'react'
import { login } from './actions'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(login, {})
  return (
    <div className="flex min-h-screen items-center justify-center">
      <form action={formAction} className="w-[360px] rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-panel)] p-6">
        <div className="mb-6 font-mono text-lg font-semibold text-[var(--color-primary)]">MetaModels</div>
        <div className="mb-4">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="username" required />
        </div>
        <div className="mb-4">
          <Label htmlFor="password">Password</Label>
          <Input id="password" name="password" type="password" autoComplete="current-password" required />
        </div>
        {state?.error && <p className="mb-4 text-sm text-[var(--color-danger)]">{state.error}</p>}
        <Button type="submit" className="w-full" disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</Button>
      </form>
    </div>
  )
}
```

- [ ] **Step 2: Implement the authed shell**

`apps/control-plane/src/app/(app)/layout.tsx`:

```tsx
import type { ReactNode } from 'react'
import { requireUser } from '../../server/guard'
import { AppSidebar } from '../../components/app-sidebar'
import { logout } from '../login/actions'
import { Button } from '../../components/ui/button'

export default async function AppLayout({ children }: { children: ReactNode }) {
  const actor = await requireUser()
  return (
    <div className="flex min-h-screen">
      <AppSidebar role={actor.role} email={actor.email} />
      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-[var(--color-border)] px-8 py-3">
          <div className="text-sm text-[var(--color-muted)]">Operator console</div>
          <form action={logout}><Button variant="ghost" type="submit">Sign out</Button></form>
        </header>
        <main className="flex-1 p-8">{children}</main>
      </div>
    </div>
  )
}
```

Update `apps/control-plane/src/app/(app)/page.tsx`:

```tsx
import { requireUser } from '../../server/guard'

export default async function DashboardPage() {
  const actor = await requireUser()
  return (
    <div>
      <h1 className="text-xl font-semibold">Welcome, {actor.email}</h1>
      <p className="mt-2 text-sm text-[var(--color-muted)]">Dashboard metrics arrive in Plan 5.5. Manage your Flocks from the sidebar.</p>
    </div>
  )
}
```

- [ ] **Step 3: Verify build + typecheck**

Run:
```bash
pnpm --filter @metamodels/control-plane exec tsc --noEmit && pnpm --filter @metamodels/control-plane build
```
Expected: no type errors; build succeeds (login + (app) routes compile).

- [ ] **Step 4: Commit**

```bash
git add apps/control-plane/src/app
git commit -m "feat(control-plane): email+password login, session cookie, protected app shell + logout"
```

---

## Task 12: Flocks page — table + Connect drawer + Test-connection

**Files:**
- Create: `apps/control-plane/src/app/(app)/flocks/page.tsx`
- Create: `apps/control-plane/src/app/(app)/flocks/actions.ts`
- Create: `apps/control-plane/src/app/(app)/flocks/flocks-client.tsx`

**Interfaces:**
- Consumes: `listFlocks`/`saveFlock`/`deleteFlock` (Task 8), `testFlockConnection`/`buildBreedRegistry` (Task 9), `requireCapabilityOr403`/`requireUser` (Task 6), UI primitives (Task 10).
- Produces: screen `9a` — Flocks table (name, breed chip, baseUrl, health) + "Connect a flock" Drawer (breed picker, baseUrl, upstreamAuth, TLS switch, **Test connection**) + delete.
- Thin glue verified by build + typecheck (services already unit-tested).

- [ ] **Step 1: Implement the server actions**

`apps/control-plane/src/app/(app)/flocks/actions.ts`:

```ts
'use server'
import { revalidatePath } from 'next/cache'
import { getDb } from '../../../server/db'
import { requireUser } from '../../../server/guard'
import { requireCapability } from '../../../auth/authorize'
import { saveFlock, deleteFlock } from '../../../server/flocks-service'
import { testFlockConnection, buildBreedRegistry } from '../../../server/flock-health'

const registry = buildBreedRegistry()

function formToInput(fd: FormData) {
  const id = String(fd.get('id') ?? '')
  const upstreamAuth = String(fd.get('upstreamAuth') ?? '').trim()
  return {
    id: id || undefined,
    breed: String(fd.get('breed') ?? ''),
    name: String(fd.get('name') ?? '').trim(),
    baseUrl: String(fd.get('baseUrl') ?? '').trim(),
    upstreamAuth: upstreamAuth || null,
    tlsTrust: String(fd.get('tlsTrust') ?? 'false') === 'true',
  }
}

export async function saveFlockAction(_prev: unknown, fd: FormData): Promise<{ error?: string; ok?: boolean }> {
  const actor = await requireUser()
  try {
    requireCapability(actor, 'resource.write')
    await saveFlock(getDb(), actor, formToInput(fd))
    revalidatePath('/flocks')
    return { ok: true }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed to save flock' }
  }
}

export async function deleteFlockAction(fd: FormData): Promise<void> {
  const actor = await requireUser()
  requireCapability(actor, 'resource.write')
  await deleteFlock(getDb(), actor, String(fd.get('id')))
  revalidatePath('/flocks')
}

export async function testConnectionAction(fd: FormData): Promise<{ ok: boolean; detail?: string }> {
  const actor = await requireUser()
  requireCapability(actor, 'resource.write')
  return testFlockConnection(registry, {
    breed: String(fd.get('breed') ?? ''),
    baseUrl: String(fd.get('baseUrl') ?? '').trim(),
    upstreamAuth: (String(fd.get('upstreamAuth') ?? '').trim() || null),
    tlsTrust: String(fd.get('tlsTrust') ?? 'false') === 'true',
  })
}
```

- [ ] **Step 2: Implement the page (server component) + client island**

`apps/control-plane/src/app/(app)/flocks/page.tsx`:

```tsx
import { getDb } from '../../../server/db'
import { requireUser } from '../../../server/guard'
import { authorize } from '../../../auth/authorize'
import { listFlocks } from '../../../server/flocks-service'
import { FlocksClient } from './flocks-client'

export default async function FlocksPage() {
  const actor = await requireUser()
  const flocks = await listFlocks(getDb(), actor)
  const canWrite = authorize(actor, 'resource.write')
  return <FlocksClient flocks={flocks.map((f) => ({
    id: f.id, name: f.name, breed: f.breed, baseUrl: f.baseUrl, healthOk: f.healthOk,
  }))} canWrite={canWrite} />
}
```

`apps/control-plane/src/app/(app)/flocks/flocks-client.tsx`:

```tsx
'use client'
import { useState } from 'react'
import { PageHeader } from '../../../components/page-header'
import { DataTable } from '../../../components/ui/data-table'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { Label } from '../../../components/ui/label'
import { Select } from '../../../components/ui/select'
import { Switch } from '../../../components/ui/switch'
import { Drawer } from '../../../components/ui/drawer'
import { StatusPill } from '../../../components/ui/status-pill'
import { BreedChip } from '../../../components/ui/breed-chip'
import { saveFlockAction, deleteFlockAction, testConnectionAction } from './actions'

interface Row { id: string; name: string; breed: string; baseUrl: string; healthOk: boolean | null }

export function FlocksClient({ flocks, canWrite }: { flocks: Row[]; canWrite: boolean }) {
  const [open, setOpen] = useState(false)
  const [tls, setTls] = useState(false)
  const [test, setTest] = useState<{ ok: boolean; detail?: string } | null>(null)
  const [error, setError] = useState<string | undefined>()

  async function onSave(fd: FormData) {
    fd.set('tlsTrust', String(tls))
    const r = await saveFlockAction(null, fd)
    if (r.error) setError(r.error)
    else { setOpen(false); setError(undefined); setTest(null); setTls(false) }
  }

  async function onTest(fd: FormData) {
    fd.set('tlsTrust', String(tls))
    setTest(await testConnectionAction(fd))
  }

  return (
    <div>
      <PageHeader
        title="Flocks"
        subtitle="Connected local AI servers behind your fence."
        actions={canWrite && <Button onClick={() => setOpen(true)}>Connect a flock</Button>}
      />
      <DataTable headers={['Name', 'Breed', 'Base URL', 'Health', '']}>
        {flocks.map((f) => (
          <tr key={f.id} className="border-b border-[var(--color-divider)]">
            <td className="px-3 py-2 text-[var(--color-text)]">{f.name}</td>
            <td className="px-3 py-2"><BreedChip breed={f.breed} /></td>
            <td className="px-3 py-2 font-mono text-xs text-[var(--color-muted)]">{f.baseUrl}</td>
            <td className="px-3 py-2"><StatusPill ok={f.healthOk} /></td>
            <td className="px-3 py-2 text-right">
              {canWrite && (
                <form action={deleteFlockAction} className="inline">
                  <input type="hidden" name="id" value={f.id} />
                  <Button variant="danger" type="submit">Delete</Button>
                </form>
              )}
            </td>
          </tr>
        ))}
        {flocks.length === 0 && (
          <tr><td colSpan={5} className="px-3 py-8 text-center text-[var(--color-muted)]">No flocks yet. Connect one to get started.</td></tr>
        )}
      </DataTable>

      <Drawer open={open} onClose={() => setOpen(false)} title="Connect a flock">
        <form action={onSave} className="flex flex-col gap-4">
          <div>
            <Label htmlFor="breed">Breed</Label>
            <Select id="breed" name="breed" defaultValue="ollama">
              <option value="ollama">ollama</option>
              <option value="comfyui">comfyui</option>
            </Select>
          </div>
          <div><Label htmlFor="name">Name</Label><Input id="name" name="name" required /></div>
          <div><Label htmlFor="baseUrl">Base URL</Label><Input id="baseUrl" name="baseUrl" placeholder="http://localhost:11434" required /></div>
          <div><Label htmlFor="upstreamAuth">Upstream auth (optional)</Label><Input id="upstreamAuth" name="upstreamAuth" /></div>
          <div className="flex items-center gap-2">
            <Switch checked={tls} onChange={setTls} name="tlsTrust" />
            <span className="text-sm text-[var(--color-muted)]">Trust self-signed TLS</span>
          </div>
          {test && (
            <div className={test.ok ? 'text-sm text-[var(--color-primary)]' : 'text-sm text-[var(--color-danger)]'}>
              {test.ok ? 'Connection OK' : `Failed: ${test.detail ?? 'unreachable'}`}
            </div>
          )}
          {error && <div className="text-sm text-[var(--color-danger)]">{error}</div>}
          <div className="flex gap-2">
            <Button type="submit">Save</Button>
            <Button type="submit" variant="ghost" formAction={onTest}>Test connection</Button>
          </div>
        </form>
      </Drawer>
    </div>
  )
}
```

- [ ] **Step 3: Verify build + typecheck**

Run:
```bash
pnpm --filter @metamodels/control-plane exec tsc --noEmit && pnpm --filter @metamodels/control-plane build
```
Expected: no type errors; `/flocks` route compiles.

- [ ] **Step 4: Run the full control-plane test suite**

Run:
```bash
pnpm --filter @metamodels/control-plane exec vitest run
```
Expected: all unit tests PASS (authorize, password, session, audit, seed, auth-service, login-throttle, flocks-service, flock-health, nav).

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/app/(app)/flocks
git commit -m "feat(control-plane): Flocks screen (9a) — table + connect drawer + test-connection + delete"
```

---

## Task 13: Root wiring, README, and whole-app verification

**Files:**
- Modify: root `package.json` (ensure `test`/`typecheck` cover the new app)
- Create: `apps/control-plane/README.md`
- Create: `apps/control-plane/.env.example`

**Interfaces:**
- Produces: documented run/seed instructions; green whole-repo `pnpm test` + `pnpm typecheck`.

- [ ] **Step 1: Confirm root scripts pick up the app**

Root `test` = `vitest run` (picks up `apps/control-plane/src/**/*.test.ts` automatically). Root `typecheck` = `tsc -b --pretty` (now includes `apps/control-plane` via the reference added in Task 1). No change needed unless `tsc -b` errors — if the Next app's `noEmit`/`jsx` config conflicts with project-references build, add `"composite": true` to `apps/control-plane/tsconfig.json` and confirm `tsc -b` passes; otherwise leave as-is.

- [ ] **Step 2: Write `.env.example`**

`apps/control-plane/.env.example`:

```bash
# Postgres (shared with the data-plane)
DATABASE_URL=postgres://localhost:5432/metamodels
# 32+ random bytes; sign the session cookie. Generate: openssl rand -base64 32
SESSION_SECRET=change-me-to-a-long-random-string
# First-run admin seed (see README)
OPERATOR_EMAIL=admin@example.com
OPERATOR_PASSWORD=change-me
```

- [ ] **Step 3: Write `README.md`**

`apps/control-plane/README.md`:

```markdown
# @metamodels/control-plane

Operator console (Next.js App Router) for MetaModels. Free tier: one admin operator.
Multi-user seats + licensing land in Plan 5.7.

## Setup
1. `cp .env.example .env` and fill in `DATABASE_URL`, `SESSION_SECRET`.
2. Run migrations from the schema package: `pnpm --filter @metamodels/schema exec drizzle-kit migrate`.
3. Seed the first admin: `OPERATOR_EMAIL=... OPERATOR_PASSWORD=... pnpm --filter @metamodels/control-plane seed`.
4. `pnpm --filter @metamodels/control-plane dev` → sign in at `/login`.

## Architecture
- Business logic lives in Next-free modules (`src/auth`, `src/server`, `src/lib`) tested with vitest + pglite.
- `authorize(user, action)` is the server-side capability boundary; UI hiding is convenience only.
- Auth: scrypt password hash + HMAC-signed httpOnly session cookie (Node `crypto`, no third-party lib).
```

- [ ] **Step 4: Whole-repo verification**

Run:
```bash
pnpm typecheck && pnpm test
```
Expected: typecheck clean across all packages; **all tests pass** (prior 163+3-skip plus the new control-plane suite).

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/README.md apps/control-plane/.env.example package.json
git commit -m "docs(control-plane): README + .env.example; confirm whole-repo test/typecheck green"
```

---

## Self-Review

**Spec coverage (against the multi-user/licensing design §2–§8 and the Plan 5.1 row):**

| Spec item | Task |
|---|---|
| Next.js app `apps/control-plane`, operator-mode theme + shell | 1, 10, 11 |
| Multi-user-capable auth (email+password, sessions) | 3, 4, 6, 7, 11 |
| Role model + `authorize()` helper used by all CRUD | 2 (+ consumed in 8, 12) |
| Reusable CRUD/Zod/audit/org-scope server pattern | 8 (pattern), 6 (audit) |
| Flocks CRUD end-to-end + Test-connection | 8, 9, 12 |
| `user.status` additive migration | 5 |
| First-run admin seed (env) | 7 |
| Role-based nav hiding (viewer/member) | 10 (nav) + 12 (canWrite) |
| Password KDF (slow, salted) | 3 (scrypt) |
| Signed httpOnly session cookie | 4 (codec) + 6 (cookie) |
| Login rate-limit | 7 (throttle) + 11 (wired) |
| Audit coverage on mutations | 8 (create/update/delete audited) |
| Security headers | 1 (next.config) |
| Docker-free tests (pglite / fetch stub) | 3, 6, 7, 8, 9 |
| Supply-chain vetting + pinned Next ≥16.2 | 1 (global constraint) |
| Screens: shell, 9a | 10, 11, 12 |

**Deferred to later sub-plans (correctly out of scope here):** `entitlement`/`invite` tables + seat enforcement + Lemon Squeezy (5.7); Paddocks/Fences (5.2); paramSchema editor (5.3); API Keys (5.4); Dashboard/Usage/Audit screens (5.5); CachingConfigStore pub/sub (5.6). Adding a second user is intentionally **not** possible in 5.1 (gated until 5.7) — only the seeded admin exists, which is exactly the free-tier behavior the spec describes.

**Placeholder scan:** none — every code step contains complete code; the only intentionally-empty landing is the dashboard placeholder (real one is 5.5), which is stated, not a TODO.

**Type consistency:** `Actor`, `Role`, `Capability` defined in Task 2 and reused verbatim in Tasks 4, 6, 7, 8, 10; `Db` defined in Task 6 and reused in 7, 8; `saveFlockInput`/`flockConnectionInput` defined in Task 8 and consumed in 9, 12; `SessionPayload` fields (`uid`/`oid`/`role`/`exp`) consistent between Task 4 codec and Task 6 cookie glue; `writeAudit` signature identical across 6 and 8.

**Deliberate deviations (recorded):** hand-authored shadcn-pattern primitives instead of the shadcn-CLI/Radix (supply-chain constraint) — refinable later; module-scoped `LoginThrottle` (fine for a single self-hosted node) — a distributed limiter is a later concern; `tsc -b` composite handling flagged as a conditional in Task 13.
