# MetaModels Plan 5.7a — Team / Users Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `user` dimension real — an admin can invite teammates (invite-then-accept, so `user.passwordHash` is never null), assign roles (admin/member/viewer), deactivate/reactivate operators, and see **seats used / free** — all enforced against a **seat limit that is base=1 today** (so adding a second operator is correctly gated with an upgrade prompt until Plan 5.7b unlocks it via a Lemon Squeezy license).

**Architecture:** New additive `invite` table (migration `0004`). Read/write services follow the established transactional CRUD template (`requireCapability → Zod → org-scope → mutation + writeAudit in ONE db.transaction`). The seat invariant `count(active users) + count(pending invites) ≤ seatLimit` is enforced server-side; the numeric `seatLimit` is supplied by a tiny `seats.ts#getSeatLimit()` that returns `BASE_SEATS = 1` in 5.7a and is the ONLY thing 5.7b rewrites. Two screens: an admin-only `/team` (behind the server-side capability gate) and a **public** `/accept-invite` (token-authenticated — the only path that creates a `user` row). This plan also folds in three in-blast-radius auth fixes deferred from Plan 5.1.

**Tech Stack:** TypeScript ESM, Next.js 16.2.0 (App Router, `next build --webpack`), Drizzle/Postgres, Vitest + pglite (real migrations, Docker-free), scrypt password hashing (Node `crypto`), signed httpOnly session cookie.

## Global Constraints

- **Node `>=24`; ESM only.** Shared package `@metamodels/schema` uses `.js` import specifiers resolving to `.ts`; the apps do NOT use `.js` specifiers within their own `src`.
- **Additive migration only.** Migrations `0000`–`0003` are frozen. This plan adds exactly one new numbered migration (`0004`) creating the `invite` table. `user.status` and the `USER_ROLES`/`USER_STATUS` enum constants ALREADY exist (Plan 5.1 migration `0002` + `packages/schema/src/enums.ts`) — do NOT re-add them.
- **No new dependency.** Everything uses existing deps (`drizzle-orm`, `zod`, Node `crypto`, Next).
- **Transactional CRUD template (codebase law):** every mutating service does `requireCapability(actor, cap)` + Zod `.parse()` BEFORE the transaction, then inside ONE `db.transaction`: org-scoped read → mutation → `writeAudit(tx, …)`; throw a `NotFoundError`/domain error INSIDE the tx on an empty `.returning()` so the mutation rolls back atomically. Copy the shape from `apps/control-plane/src/server/keys-service.ts`.
- **`authorize()` is the boundary.** Every write path calls `requireCapability(actor, cap)`; admin-only pages ALSO call the page guard. UI hiding (nav, buttons) is convenience only, never the enforcement.
- **Capabilities:** user management uses the EXISTING capability string `'user.manage'` (admin only, per the matrix in `authorize.ts`). Do NOT invent new capability strings in this plan.
- **Seat invariant:** `count(active users) + count(pending invites) ≤ seatLimit`. `seatLimit` is a NUMBER passed into the seat-consuming services; the action/page layer obtains it via `getSeatLimit(db, orgId)` which returns `BASE_SEATS = 1` in this plan. A pending (un-accepted, un-expired) invite reserves a seat; revoking/expiring it or deactivating a user frees one; accepting an invite converts the reserved seat to a user (net-zero).
- **No plaintext secrets.** Passwords are scrypt-hashed (`hashPassword`), never stored/returned/logged in plaintext. The invite token is shown ONCE at invite time (like the shown-once API key); only its SHA-256 hash is persisted.
- **User management is NOT config.** Users/invites do not affect the data-plane hot path (keys/paddocks/fences), so these actions do NOT call `publishConfigInvalidation` — keep this plan decoupled from Redis.
- **Tests stay Docker-free:** control-plane logic tested against pglite running the REAL migrations via `apps/control-plane/src/test/db.ts` (`freshDb`/`seedOrg`).
- **Git identity:** `Carmelo Santana <me@carmelosantana.com>`. Branch: `feat/metamodels-plan5.7a`.
- **Test lanes:** root `pnpm test` (baseline **189 pass / 3 skip**), control-plane `pnpm --filter @metamodels/control-plane exec vitest run` (baseline **112 pass**), workspace typecheck `pnpm -w exec tsc -b`, control-plane `pnpm --filter @metamodels/control-plane exec next build --webpack`. Every task keeps them green. (Two pre-existing scrypt tests can time out under CPU contention — a known flake; re-run the control-plane lane with `--testTimeout=30000`.)

---

## File Structure

```
packages/schema/src/
  schema.ts                                  # MODIFY: + invite table
packages/schema/drizzle/
  0004_*.sql + meta/                         # CREATE via drizzle-kit generate: invite table DDL

apps/control-plane/src/auth/
  authorize.ts                               # MODIFY: Role ← schema UserRole; isRole via USER_ROLES; exhaustive-matrix satisfies
apps/control-plane/src/server/
  auth-service.ts                            # MODIFY: verifyLogin dummy-hash timing fix
  guard.ts                                   # MODIFY: + requireCapabilityOr403 page guard
  seats.ts                                   # CREATE: BASE_SEATS, getSeatLimit, seat counts, seatUsage
  users-service.ts                           # CREATE: listUsers, changeUserRole, setUserStatus (+ guards)
  invites-service.ts                         # CREATE: inviteUser, revokeInvite, listPendingInvites, acceptInvite
apps/control-plane/src/server/*.test.ts      # CREATE co-located tests for each new/changed service
apps/control-plane/src/app/(app)/team/
  page.tsx                                   # CREATE: admin-only Team screen (server)
  team-client.tsx                            # CREATE: users table + invite drawer + row actions + seats header
  actions.ts                                 # CREATE: invite/revoke/change-role/set-status server actions
apps/control-plane/src/app/accept-invite/
  page.tsx                                   # CREATE: PUBLIC server page (reads ?token=), renders the form
  accept-invite-form.tsx                     # CREATE: 'use client' set-password form (mirrors login/page.tsx)
  actions.ts                                 # CREATE: acceptInviteAction → create user + session + redirect
```

Note on test lanes: services live under `src/**` so their co-located `*.test.ts` run in the **control-plane** lane. Only the schema change (Task 2) moves the **root** lane count (via `packages/schema`), and it has no new root test — the migration is exercised implicitly by every control-plane pglite test. Expect the root lane to stay **189/3** and the control-plane lane to grow from **112**.

---

### Task 1: Bridge `authorize.ts` Role to the schema `USER_ROLES` (Plan 5.1 carry-forward)

Link the control-plane's local `Role` union to the schema's single source of truth so a role added to `USER_ROLES` can't silently miss the capability matrix.

**Files:**
- Modify: `apps/control-plane/src/auth/authorize.ts`
- Create: `apps/control-plane/src/auth/authorize.test.ts`

**Interfaces:**
- Consumes: `USER_ROLES`, `type UserRole` from `@metamodels/schema`.
- Produces (unchanged public surface): `type Role` (now `= UserRole`), `type Capability`, `interface Actor`, `authorize`, `requireCapability`, `ForbiddenError`, `isRole` — same names/shapes as today.

- [ ] **Step 1: Write the failing test**

Create `apps/control-plane/src/auth/authorize.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import { USER_ROLES } from '@metamodels/schema'
import { authorize, requireCapability, isRole, ForbiddenError, type Role, type Capability } from './authorize'

describe('authorize role/capability matrix', () => {
  test('every schema USER_ROLES value is a known Role in the matrix', () => {
    // If a role is added to the schema but not the matrix, authorize() would silently deny
    // everything for it — assert each schema role resolves through the matrix deterministically.
    for (const role of USER_ROLES) {
      expect(isRole(role)).toBe(true)
      // 'read' is granted to all three current roles; this proves the row exists (not undefined).
      expect(typeof authorize({ role: role as Role }, 'read')).toBe('boolean')
    }
  })

  test('capability grants match the spec', () => {
    expect(authorize({ role: 'admin' }, 'user.manage')).toBe(true)
    expect(authorize({ role: 'member' }, 'user.manage')).toBe(false)
    expect(authorize({ role: 'viewer' }, 'resource.write')).toBe(false)
    expect(authorize({ role: 'viewer' }, 'read')).toBe(true)
  })

  test('isRole rejects non-roles and accepts schema roles', () => {
    expect(isRole('admin')).toBe(true)
    expect(isRole('root')).toBe(false)
    expect(isRole(null)).toBe(false)
  })

  test('requireCapability throws ForbiddenError with the capability', () => {
    const actor = { id: 'u', orgId: 'o', email: 'v@x.io', role: 'viewer' as Role }
    const cap: Capability = 'resource.write'
    expect(() => requireCapability(actor, cap)).toThrow(ForbiddenError)
  })
})
```

- [ ] **Step 2: Run it — expect fail (or non-exhaustive) before the bridge**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/auth/authorize.test.ts`
Expected: the file may already pass for today's three hardcoded roles, but it does not yet PROVE the matrix is keyed off the schema. Proceed to wire the bridge so the guarantee is structural.

- [ ] **Step 3: Rewrite the head of `authorize.ts` to derive `Role` from the schema**

Replace lines 1–2 of `apps/control-plane/src/auth/authorize.ts`:
```ts
export type Role = 'admin' | 'member' | 'viewer'
export type Capability = 'read' | 'resource.write' | 'user.manage' | 'license.manage'
```
with:
```ts
import { USER_ROLES, type UserRole } from '@metamodels/schema'

export type Role = UserRole
export type Capability = 'read' | 'resource.write' | 'user.manage' | 'license.manage'
```
Then replace the `MATRIX` declaration so a missing role fails to compile:
```ts
const MATRIX = {
  admin: { read: true, 'resource.write': true, 'user.manage': true, 'license.manage': true },
  member: { read: true, 'resource.write': true, 'user.manage': false, 'license.manage': false },
  viewer: { read: true, 'resource.write': false, 'user.manage': false, 'license.manage': false },
} satisfies Record<Role, Record<Capability, boolean>>
```
And replace `isRole` so it is keyed off the schema list (no hardcoded triple):
```ts
export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (USER_ROLES as readonly string[]).includes(v)
}
```
(Leave `Actor`, `ForbiddenError`, `authorize`, `requireCapability` unchanged.)

- [ ] **Step 4: Run it — expect pass**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/auth/authorize.test.ts`
Expected: PASS (4 tests). Then `pnpm -w exec tsc -b` — clean (the `satisfies` now ties `MATRIX` to `Role = UserRole`; if `USER_ROLES` ever gains a value with no matrix row, `tsc` fails here).

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/auth/authorize.ts apps/control-plane/src/auth/authorize.test.ts
git commit -m "fix(control-plane): bind authorize Role to schema USER_ROLES (exhaustive matrix)"
```

---

### Task 2: `invite` table + migration `0004`

**Files:**
- Modify: `packages/schema/src/schema.ts`
- Create: `packages/schema/drizzle/0004_*.sql` (+ updated `meta/_journal.json`) via drizzle-kit
- Create: `apps/control-plane/src/server/invite-schema.test.ts`

**Interfaces:**
- Produces: `invite` pgTable exported from `@metamodels/schema` with columns `id` (uuid pk), `orgId` (uuid, FK org, cascade), `email` (text), `role` (text), `tokenHash` (text), `expiresAt` (timestamptz), `acceptedAt` (timestamptz nullable), `createdAt` (timestamptz default now).

- [ ] **Step 1: Add the table to `schema.ts`**

In `packages/schema/src/schema.ts`, after the `user` table (ends at line 20) and before `flock`, add:
```ts
export const invite = pgTable('invite', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  createdAt: createdAt(),
})
```
(`id`, `createdAt`, `pgTable`, `text`, `uuid`, `timestamp`, `org` are already imported/defined at the top of the file.)

- [ ] **Step 2: Generate the migration**

Run: `pnpm --filter @metamodels/schema exec drizzle-kit generate`
Expected: a new `packages/schema/drizzle/0004_*.sql` containing `CREATE TABLE "invite" (...)` with the FK to `org` and a UNIQUE on `token_hash`, plus an updated `meta/_journal.json` (entry index 4) and a `meta/0004_snapshot.json`. Migrations `0000`–`0003` are untouched. Inspect the generated SQL to confirm it only CREATEs `invite` (no ALTER to existing tables).

- [ ] **Step 3: Write a test that the migration applies and the shape is right**

Create `apps/control-plane/src/server/invite-schema.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import * as schema from '@metamodels/schema'
import { freshDb, seedOrg } from '../test/db'

describe('invite table (migration 0004)', () => {
  test('freshDb applies 0004 and invite round-trips', async () => {
    const db = await freshDb() // runs ALL migrations incl. 0004
    const o = await seedOrg(db)
    const [row] = await db.insert(schema.invite).values({
      orgId: o.id, email: 'teammate@x.io', role: 'member',
      tokenHash: 'deadbeef', expiresAt: new Date(Date.now() + 86_400_000),
    }).returning()
    expect(row.id).toBeTruthy()
    expect(row.orgId).toBe(o.id)
    expect(row.email).toBe('teammate@x.io')
    expect(row.role).toBe('member')
    expect(row.acceptedAt).toBeNull()
    expect(row.createdAt).toBeInstanceOf(Date)
  })

  test('token_hash is unique', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const base = { orgId: o.id, email: 'a@x.io', role: 'member', tokenHash: 'dup', expiresAt: new Date(Date.now() + 86_400_000) }
    await db.insert(schema.invite).values(base).returning()
    await expect(db.insert(schema.invite).values({ ...base, email: 'b@x.io' }).returning()).rejects.toThrow()
  })
})
```

- [ ] **Step 4: Run it — expect pass; typecheck; both lanes**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/invite-schema.test.ts` → PASS (2 tests).
Run: `pnpm -w exec tsc -b` → clean.
Run: `pnpm test` → root green **189 pass / 3 skip** (unchanged — the schema addition adds no root test; `packages/schema` still builds). If a `packages/schema` build/typecheck step exists in the root lane, it stays green.

- [ ] **Step 5: Commit**

```bash
git add packages/schema/src/schema.ts packages/schema/drizzle apps/control-plane/src/server/invite-schema.test.ts
git commit -m "feat(schema): invite table + migration 0004 (invite-then-accept groundwork)"
```

---

### Task 3: `verifyLogin` dummy-hash timing fix (Plan 5.1 carry-forward)

Close the login timing oracle: today `verifyLogin` returns immediately on an unknown email WITHOUT hashing, so response latency distinguishes known from unknown emails. Do equivalent scrypt work on the miss path.

**Files:**
- Modify: `apps/control-plane/src/server/auth-service.ts`
- Modify: `apps/control-plane/src/server/auth-service.test.ts` (append)

**Interfaces:**
- Consumes: `verifyPassword` (already imported).
- Produces: `verifyLogin` — same signature/return (`LoginResult`); adds a module constant `DUMMY_PASSWORD_HASH`.

- [ ] **Step 1: Generate a fixed, well-formed dummy scrypt hash**

Run this once and copy the single-line output:
```bash
pnpm --filter @metamodels/control-plane exec tsx -e "import('./src/auth/password.ts').then(m => m.hashPassword('metamodels-timing-dummy')).then(h => console.log(h))"
```
Expected: a string like `scrypt$<32-hex-salt>$<128-hex-key>`. (If `tsx` is unavailable, use `node --experimental-strip-types` or any runner that can import the TS module; the value only needs to be a valid `scrypt$salt$hash` triple. Its exact bytes don't matter — it is a throwaway target used solely to spend hash time.)

- [ ] **Step 2: Write the failing test**

Append to `apps/control-plane/src/server/auth-service.test.ts`:
```ts
import { DUMMY_PASSWORD_HASH } from './auth-service'
import { verifyPassword } from '../auth/password'

describe('verifyLogin timing-oracle mitigation', () => {
  test('DUMMY_PASSWORD_HASH is a well-formed scrypt hash the KDF actually processes', async () => {
    expect(DUMMY_PASSWORD_HASH).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/)
    // A real (failing) verify against it — proves the miss path spends genuine scrypt time.
    expect(await verifyPassword('anything', DUMMY_PASSWORD_HASH)).toBe(false)
  })

  test('unknown email still returns the generic invalid result (behavior preserved)', async () => {
    const db = await freshDb()
    const res = await verifyLogin(db, 'nobody@x.io', 'whatever')
    expect(res).toEqual({ ok: false, reason: 'invalid' })
  })
})
```
(Check the top of `auth-service.test.ts`: it must import `verifyLogin`, `freshDb`, and `describe/expect/test`. If `freshDb` isn't already imported, add `import { freshDb } from '../test/db'`.)

- [ ] **Step 3: Run it — expect fail**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/auth-service.test.ts`
Expected: FAIL — `DUMMY_PASSWORD_HASH` is not exported yet.

- [ ] **Step 4: Implement the fix**

In `apps/control-plane/src/server/auth-service.ts`, add the constant (paste YOUR generated value from Step 1) after the imports:
```ts
/**
 * A fixed, well-formed scrypt hash used ONLY to spend equivalent KDF time on the
 * unknown-email path, so login latency does not reveal whether an email exists.
 * The value is a throwaway — it never matches any real password.
 */
export const DUMMY_PASSWORD_HASH =
  'scrypt$REPLACE_WITH_GENERATED_SALT$REPLACE_WITH_GENERATED_KEY'
```
Then change the unknown-email branch of `verifyLogin`. Replace:
```ts
  const u = rows[0]
  if (!u) return { ok: false, reason: 'invalid' }
```
with:
```ts
  const u = rows[0]
  if (!u) {
    // Spend equivalent scrypt time so an unknown email is timing-indistinguishable
    // from a known email with a wrong password. Result is intentionally discarded.
    await verifyPassword(password, DUMMY_PASSWORD_HASH)
    return { ok: false, reason: 'invalid' }
  }
```

- [ ] **Step 5: Run it — expect pass**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/auth-service.test.ts`
Expected: PASS (existing auth-service tests + 2 new). Then `pnpm -w exec tsc -b` → clean.

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane/src/server/auth-service.ts apps/control-plane/src/server/auth-service.test.ts
git commit -m "fix(control-plane): equalize verifyLogin timing on unknown-email path (dummy scrypt)"
```

---

### Task 4: `seats.ts` — seat limit + usage counting

The seat seam. `getSeatLimit` returns `BASE_SEATS = 1` here; Plan 5.7b rewrites ONLY this function to read the entitlement.

**Files:**
- Create: `apps/control-plane/src/server/seats.ts`
- Create: `apps/control-plane/src/server/seats.test.ts`

**Interfaces:**
- Consumes: `user`, `invite` from `@metamodels/schema`; `type Db` from `./db`; `requireCapability`, `type Actor` from `../auth/authorize`.
- Produces:
  - `const BASE_SEATS = 1`
  - `getSeatLimit(db: Db, orgId: string): Promise<number>` — returns `BASE_SEATS` in 5.7a.
  - `countActiveUsers(db: Db, orgId: string): Promise<number>`
  - `countPendingInvites(db: Db, orgId: string, nowMs: number): Promise<number>` — pending = `acceptedAt IS NULL AND expiresAt > now`.
  - `interface SeatUsage { used: number; limit: number; free: number }`
  - `seatUsage(db: Db, actor: Actor, limit: number, nowMs: number): Promise<SeatUsage>` — `requireCapability(actor, 'user.manage')`; `used = active + pending`; `free = max(0, limit - used)`.

- [ ] **Step 1: Write the failing test**

Create `apps/control-plane/src/server/seats.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import * as schema from '@metamodels/schema'
import { freshDb, seedOrg, type TestDb } from '../test/db'
import { BASE_SEATS, getSeatLimit, countActiveUsers, countPendingInvites, seatUsage } from './seats'
import { ForbiddenError, type Actor } from '../auth/authorize'

const NOW = 1_800_000_000_000

async function admin(db: TestDb, orgId: string): Promise<Actor> {
  return { id: 'admin', orgId, email: 'admin@x.io', role: 'admin' }
}
async function addUser(db: TestDb, orgId: string, email: string, status: 'active' | 'deactivated') {
  await db.insert(schema.user).values({ orgId, email, passwordHash: 'scrypt$x$y', role: 'member', status }).returning()
}
async function addInvite(db: TestDb, orgId: string, email: string, expiresAt: Date, acceptedAt: Date | null) {
  await db.insert(schema.invite).values({ orgId, email, role: 'member', tokenHash: email, expiresAt, acceptedAt }).returning()
}

describe('seats', () => {
  test('getSeatLimit is BASE_SEATS (1) in 5.7a', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    expect(BASE_SEATS).toBe(1)
    expect(await getSeatLimit(db, o.id)).toBe(1)
  })

  test('countActiveUsers ignores deactivated and other orgs', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const other = await seedOrg(db, 'other')
    await addUser(db, o.id, 'a@x.io', 'active')
    await addUser(db, o.id, 'b@x.io', 'deactivated')
    await addUser(db, other.id, 'c@x.io', 'active')
    expect(await countActiveUsers(db, o.id)).toBe(1)
  })

  test('countPendingInvites counts only un-accepted, un-expired, same-org invites', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    await addInvite(db, o.id, 'pending@x.io', new Date(NOW + 1000), null)      // pending
    await addInvite(db, o.id, 'expired@x.io', new Date(NOW - 1000), null)      // expired → not counted
    await addInvite(db, o.id, 'accepted@x.io', new Date(NOW + 1000), new Date(NOW)) // accepted → not counted
    expect(await countPendingInvites(db, o.id, NOW)).toBe(1)
  })

  test('seatUsage sums active + pending against the limit', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    await addUser(db, o.id, 'a@x.io', 'active')
    await addInvite(db, o.id, 'p@x.io', new Date(NOW + 1000), null)
    const usage = await seatUsage(db, await admin(db, o.id), 5, NOW)
    expect(usage).toEqual({ used: 2, limit: 5, free: 3 })
  })

  test('seatUsage requires user.manage', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const viewer: Actor = { id: 'v', orgId: o.id, email: 'v@x.io', role: 'viewer' }
    await expect(seatUsage(db, viewer, 1, NOW)).rejects.toThrow(ForbiddenError)
  })
})
```

- [ ] **Step 2: Run it — expect fail**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/seats.test.ts`
Expected: FAIL — `Cannot find module './seats'`.

- [ ] **Step 3: Implement `seats.ts`**

Create `apps/control-plane/src/server/seats.ts`:
```ts
import { and, count, eq, gt, isNull } from 'drizzle-orm'
import { invite, user } from '@metamodels/schema'
import type { Db } from './db'
import { requireCapability, type Actor } from '../auth/authorize'

/** Free/AGPL tier: one operator seat. Plan 5.7b rewrites getSeatLimit to read the entitlement. */
export const BASE_SEATS = 1

export async function getSeatLimit(_db: Db, _orgId: string): Promise<number> {
  return BASE_SEATS
}

export async function countActiveUsers(db: Db, orgId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(user)
    .where(and(eq(user.orgId, orgId), eq(user.status, 'active')))
  return row?.n ?? 0
}

export async function countPendingInvites(db: Db, orgId: string, nowMs: number): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(invite)
    .where(and(eq(invite.orgId, orgId), isNull(invite.acceptedAt), gt(invite.expiresAt, new Date(nowMs))))
  return row?.n ?? 0
}

export interface SeatUsage {
  used: number
  limit: number
  free: number
}

export async function seatUsage(db: Db, actor: Actor, limit: number, nowMs: number): Promise<SeatUsage> {
  requireCapability(actor, 'user.manage')
  const [active, pending] = await Promise.all([
    countActiveUsers(db, actor.orgId),
    countPendingInvites(db, actor.orgId, nowMs),
  ])
  const used = active + pending
  return { used, limit, free: Math.max(0, limit - used) }
}
```

- [ ] **Step 4: Run it — expect pass; typecheck**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/seats.test.ts` → PASS (5 tests).
Run: `pnpm -w exec tsc -b` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/server/seats.ts apps/control-plane/src/server/seats.test.ts
git commit -m "feat(control-plane): seats module — base=1 seat limit + active/pending usage counting"
```

---

### Task 5: `users-service.ts` — list users, change role, deactivate/reactivate

**Files:**
- Create: `apps/control-plane/src/server/users-service.ts`
- Create: `apps/control-plane/src/server/users-service.test.ts`

**Interfaces:**
- Consumes: `user` from `@metamodels/schema`; `type Db`; `requireCapability`, `type Actor`, `isRole`, `type Role`; `writeAudit`; `NotFoundError` (re-exported from `./flocks-service`); `countActiveUsers` from `./seats`.
- Produces:
  - `interface UserRow { id; email; role; status; createdAt: Date }`
  - `listUsers(db, actor): Promise<UserRow[]>` — `requireCapability('user.manage')`, org-scoped, ordered by `createdAt`.
  - `class LastAdminError extends Error` / `class SelfActionError extends Error` / `class SeatLimitError extends Error`.
  - `changeUserRole(db, actor, userId: string, role: Role): Promise<void>` — org-scoped; cannot demote the last active admin; audited `user.role`.
  - `setUserStatus(db, actor, userId: string, status: 'active' | 'deactivated', seatLimit: number, nowMs: number): Promise<void>` — org-scoped; cannot deactivate yourself; cannot deactivate the last active admin; reactivating requires a free seat; audited `user.deactivate` / `user.reactivate`.
- Re-export: `export { NotFoundError }`.

- [ ] **Step 1: Write the failing test**

Create `apps/control-plane/src/server/users-service.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '@metamodels/schema'
import { freshDb, seedOrg, type TestDb } from '../test/db'
import { listUsers, changeUserRole, setUserStatus, LastAdminError, SelfActionError, SeatLimitError, NotFoundError } from './users-service'
import { ForbiddenError, type Actor } from '../auth/authorize'

const NOW = 1_800_000_000_000

async function seedUser(db: TestDb, orgId: string, email: string, role: string, status = 'active') {
  const [u] = await db.insert(schema.user).values({ orgId, email, passwordHash: 'scrypt$x$y', role, status }).returning()
  return u
}
function actor(u: { id: string; orgId: string; email: string }, role: Actor['role'] = 'admin'): Actor {
  return { id: u.id, orgId: u.orgId, email: u.email, role }
}

describe('users-service', () => {
  test('listUsers is org-scoped, ordered, and requires user.manage', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const a = await seedUser(db, o.id, 'admin@x.io', 'admin')
    await seedUser(db, o.id, 'm@x.io', 'member')
    const other = await seedOrg(db, 'other')
    await seedUser(db, other.id, 'x@x.io', 'member')

    const rows = await listUsers(db, actor(a))
    expect(rows.map((r) => r.email)).toEqual(['admin@x.io', 'm@x.io'])

    const viewer: Actor = { ...actor(a), role: 'viewer' }
    await expect(listUsers(db, viewer)).rejects.toThrow(ForbiddenError)
  })

  test('changeUserRole updates and audits; cannot demote the last admin', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const a = await seedUser(db, o.id, 'admin@x.io', 'admin')
    const m = await seedUser(db, o.id, 'm@x.io', 'member')

    await changeUserRole(db, actor(a), m.id, 'admin')
    const [mAfter] = await db.select().from(schema.user).where(eq(schema.user.id, m.id))
    expect(mAfter.role).toBe('admin')

    // Now demote the original admin — allowed, since m is admin now.
    await changeUserRole(db, actor(a), a.id, 'member')
    // Attempt to demote the last remaining admin (m) → blocked.
    await expect(changeUserRole(db, actor(m), m.id, 'member')).rejects.toThrow(LastAdminError)

    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'user.role'))
    expect(audits.length).toBe(2)
  })

  test('changeUserRole rejects unknown/cross-org target', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const a = await seedUser(db, o.id, 'admin@x.io', 'admin')
    const other = await seedOrg(db, 'other')
    const x = await seedUser(db, other.id, 'x@x.io', 'member')
    await expect(changeUserRole(db, actor(a), x.id, 'admin')).rejects.toThrow(NotFoundError)
  })

  test('setUserStatus: cannot deactivate self or the last admin', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const a = await seedUser(db, o.id, 'admin@x.io', 'admin')
    await expect(setUserStatus(db, actor(a), a.id, 'deactivated', 5, NOW)).rejects.toThrow(SelfActionError)

    const a2 = await seedUser(db, o.id, 'admin2@x.io', 'admin')
    await setUserStatus(db, actor(a), a2.id, 'deactivated', 5, NOW) // ok, a still admin
    // a is now the last active admin; another admin cannot be created to deactivate a here,
    // so assert the last-admin guard via a fresh minimal org:
    const o2 = await seedOrg(db, 'solo')
    const solo = await seedUser(db, o2.id, 'solo@x.io', 'admin')
    const helper = await seedUser(db, o2.id, 'helper@x.io', 'admin')
    await setUserStatus(db, actor(solo), helper.id, 'deactivated', 5, NOW)
    await expect(setUserStatus(db, actor(helper, 'admin'), solo.id, 'deactivated', 5, NOW)).rejects.toThrow(NotFoundError)
    // (helper is deactivated → getCurrentActor would already block; the service still org-scopes.)
  })

  test('reactivation is blocked when no seat is free, allowed when seats remain', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const a = await seedUser(db, o.id, 'admin@x.io', 'admin')
    const m = await seedUser(db, o.id, 'm@x.io', 'member', 'deactivated')
    // limit=1, admin already active → no free seat → reactivation blocked
    await expect(setUserStatus(db, actor(a), m.id, 'active', 1, NOW)).rejects.toThrow(SeatLimitError)
    // limit=2 → one free seat → allowed
    await setUserStatus(db, actor(a), m.id, 'active', 2, NOW)
    const [mAfter] = await db.select().from(schema.user).where(eq(schema.user.id, m.id))
    expect(mAfter.status).toBe('active')
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'user.reactivate'))
    expect(audits.length).toBe(1)
  })
})
```

- [ ] **Step 2: Run it — expect fail**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/users-service.test.ts`
Expected: FAIL — `Cannot find module './users-service'`.

- [ ] **Step 3: Implement `users-service.ts`**

Create `apps/control-plane/src/server/users-service.ts`:
```ts
import { and, asc, eq, ne } from 'drizzle-orm'
import { user } from '@metamodels/schema'
import type { Db } from './db'
import { requireCapability, type Actor, type Role } from '../auth/authorize'
import { writeAudit } from './audit'
import { NotFoundError } from './flocks-service'
import { countActiveUsers, countPendingInvites } from './seats'

export { NotFoundError }

export class LastAdminError extends Error {
  constructor() {
    super('cannot remove the last active admin')
    this.name = 'LastAdminError'
  }
}
export class SelfActionError extends Error {
  constructor() {
    super('you cannot deactivate your own account')
    this.name = 'SelfActionError'
  }
}
export class SeatLimitError extends Error {
  constructor() {
    super('seat limit reached — upgrade, revoke a pending invite, or deactivate a user')
    this.name = 'SeatLimitError'
  }
}

export interface UserRow {
  id: string
  email: string
  role: string
  status: string
  createdAt: Date
}

export async function listUsers(db: Db, actor: Actor): Promise<UserRow[]> {
  requireCapability(actor, 'user.manage')
  return db
    .select({ id: user.id, email: user.email, role: user.role, status: user.status, createdAt: user.createdAt })
    .from(user)
    .where(eq(user.orgId, actor.orgId))
    .orderBy(asc(user.createdAt))
}

/** Count OTHER active admins in the org (excludes `exceptId`). Used for the last-admin guard. */
async function otherActiveAdmins(db: Db, orgId: string, exceptId: string): Promise<number> {
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.orgId, orgId), eq(user.role, 'admin'), eq(user.status, 'active'), ne(user.id, exceptId)))
  return rows.length
}

export async function changeUserRole(db: Db, actor: Actor, userId: string, role: Role): Promise<void> {
  requireCapability(actor, 'user.manage')
  await db.transaction(async (tx) => {
    const [target] = await tx.select().from(user).where(and(eq(user.id, userId), eq(user.orgId, actor.orgId)))
    if (!target) throw new NotFoundError(`user ${userId}`)
    // Demoting the last active admin away from 'admin' would strand the org with no admin.
    if (target.role === 'admin' && role !== 'admin' && target.status === 'active') {
      if ((await otherActiveAdmins(tx, actor.orgId, userId)) === 0) throw new LastAdminError()
    }
    await tx.update(user).set({ role }).where(and(eq(user.id, userId), eq(user.orgId, actor.orgId)))
    await writeAudit(tx, {
      orgId: actor.orgId, actor: actor.email, action: 'user.role',
      target: `user:${userId}`, detail: { role },
    })
  })
}

export async function setUserStatus(
  db: Db, actor: Actor, userId: string, status: 'active' | 'deactivated', seatLimit: number, nowMs: number,
): Promise<void> {
  requireCapability(actor, 'user.manage')
  if (status === 'deactivated' && userId === actor.id) throw new SelfActionError()
  await db.transaction(async (tx) => {
    const [target] = await tx.select().from(user).where(and(eq(user.id, userId), eq(user.orgId, actor.orgId)))
    if (!target) throw new NotFoundError(`user ${userId}`)
    if (status === 'deactivated' && target.role === 'admin' && target.status === 'active') {
      if ((await otherActiveAdmins(tx, actor.orgId, userId)) === 0) throw new LastAdminError()
    }
    if (status === 'active' && target.status !== 'active') {
      // Reactivating consumes a seat — enforce the invariant.
      const active = await countActiveUsers(tx, actor.orgId)
      const pending = await countPendingInvites(tx, actor.orgId, nowMs)
      if (active + pending >= seatLimit) throw new SeatLimitError()
    }
    await tx.update(user).set({ status }).where(and(eq(user.id, userId), eq(user.orgId, actor.orgId)))
    await writeAudit(tx, {
      orgId: actor.orgId, actor: actor.email,
      action: status === 'active' ? 'user.reactivate' : 'user.deactivate',
      target: `user:${userId}`,
    })
  })
}
```
Note: `countActiveUsers`/`countPendingInvites` accept a `Db`; a Drizzle transaction handle satisfies that type, so passing `tx` runs the counts inside the transaction (consistent snapshot).

- [ ] **Step 4: Run it — expect pass; typecheck**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/users-service.test.ts` → PASS (5 tests).
Run: `pnpm -w exec tsc -b` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/server/users-service.ts apps/control-plane/src/server/users-service.test.ts
git commit -m "feat(control-plane): users-service — list, change-role, deactivate/reactivate with guards"
```

---

### Task 6: `invites-service.ts` — invite (seat-gated, shown-once token) + revoke + list pending

**Files:**
- Create: `apps/control-plane/src/server/invites-service.ts`
- Create: `apps/control-plane/src/server/invites-service.test.ts`

**Interfaces:**
- Consumes: `invite` from `@metamodels/schema`; `type Db`; `requireCapability`, `type Actor`, `isRole`, `type Role`; `writeAudit`; `NotFoundError`; `SeatLimitError` (re-export from `./users-service`); `countActiveUsers`/`countPendingInvites` from `./seats`; Node `crypto` (`randomBytes`, `createHash`).
- Produces:
  - `hashInviteToken(token: string): string` — `sha256` hex.
  - `interface PendingInvite { id; email; role; expiresAt: Date; createdAt: Date }`
  - `interface CreatedInvite { id; email; role: string; token: string }` — `token` surfaced ONCE.
  - `inviteUser(db, actor, input: unknown, seatLimit: number, nowMs: number): Promise<CreatedInvite>` — Zod parse `{ email, role }`; seat-gated; inserts invite with `tokenHash`; audited `user.invite`.
  - `listPendingInvites(db, actor, nowMs): Promise<PendingInvite[]>`
  - `revokeInvite(db, actor, id: string): Promise<void>` — org-scoped delete of a pending invite; audited `invite.revoke`.

- [ ] **Step 1: Write the failing test**

Create `apps/control-plane/src/server/invites-service.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '@metamodels/schema'
import { freshDb, seedOrg, type TestDb } from '../test/db'
import { inviteUser, listPendingInvites, revokeInvite, hashInviteToken, SeatLimitError, NotFoundError } from './invites-service'
import { ForbiddenError, type Actor } from '../auth/authorize'

const NOW = 1_800_000_000_000

async function seedAdminUser(db: TestDb, orgId: string): Promise<Actor> {
  const [u] = await db.insert(schema.user).values({ orgId, email: 'admin@x.io', passwordHash: 'scrypt$x$y', role: 'admin', status: 'active' }).returning()
  return { id: u.id, orgId, email: u.email, role: 'admin' }
}

describe('invites-service', () => {
  test('inviteUser stores only a token hash and returns the token once (seat available)', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const admin = await seedAdminUser(db, o.id)
    const created = await inviteUser(db, admin, { email: 'teammate@x.io', role: 'member' }, 5, NOW)

    expect(created.email).toBe('teammate@x.io')
    expect(created.role).toBe('member')
    expect(created.token.length).toBeGreaterThan(20)

    const [row] = await db.select().from(schema.invite).where(eq(schema.invite.id, created.id))
    expect(row.tokenHash).toBe(hashInviteToken(created.token))
    expect(row.tokenHash).not.toBe(created.token)      // hash, never plaintext
    expect(JSON.stringify(row)).not.toContain(created.token)
    expect(row.acceptedAt).toBeNull()

    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'user.invite'))
    expect(audits.length).toBe(1)
  })

  test('inviteUser is blocked at the seat limit (base=1, seeded admin fills it)', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const admin = await seedAdminUser(db, o.id)
    // limit=1, one active user → no seat → invite blocked (this is the out-of-the-box 5.7a gate)
    await expect(inviteUser(db, admin, { email: 't@x.io', role: 'member' }, 1, NOW)).rejects.toThrow(SeatLimitError)
  })

  test('a pending invite reserves a seat (second invite blocked at limit=2 with 1 admin + 1 pending)', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const admin = await seedAdminUser(db, o.id)
    await inviteUser(db, admin, { email: 'a@x.io', role: 'member' }, 2, NOW) // used=2 (admin+pending)
    await expect(inviteUser(db, admin, { email: 'b@x.io', role: 'member' }, 2, NOW)).rejects.toThrow(SeatLimitError)
  })

  test('inviteUser requires user.manage and validates role', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const admin = await seedAdminUser(db, o.id)
    const member: Actor = { ...admin, role: 'member' }
    await expect(inviteUser(db, member, { email: 'x@x.io', role: 'member' }, 5, NOW)).rejects.toThrow(ForbiddenError)
    await expect(inviteUser(db, admin, { email: 'x@x.io', role: 'root' }, 5, NOW)).rejects.toThrow()
    await expect(inviteUser(db, admin, { email: 'not-an-email', role: 'member' }, 5, NOW)).rejects.toThrow()
  })

  test('listPendingInvites excludes expired/accepted; revokeInvite frees the seat', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const admin = await seedAdminUser(db, o.id)
    const created = await inviteUser(db, admin, { email: 'p@x.io', role: 'member' }, 5, NOW)
    expect((await listPendingInvites(db, admin, NOW)).map((i) => i.email)).toEqual(['p@x.io'])

    await revokeInvite(db, admin, created.id)
    expect(await listPendingInvites(db, admin, NOW)).toEqual([])
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'invite.revoke'))
    expect(audits.length).toBe(1)

    await expect(revokeInvite(db, admin, created.id)).rejects.toThrow(NotFoundError) // already gone
  })
})
```

- [ ] **Step 2: Run it — expect fail**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/invites-service.test.ts`
Expected: FAIL — `Cannot find module './invites-service'`.

- [ ] **Step 3: Implement `invites-service.ts`**

Create `apps/control-plane/src/server/invites-service.ts`:
```ts
import { createHash, randomBytes } from 'node:crypto'
import { and, asc, eq, gt, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { invite, USER_ROLES } from '@metamodels/schema'
import type { Db } from './db'
import { requireCapability, type Actor } from '../auth/authorize'
import { writeAudit } from './audit'
import { NotFoundError, SeatLimitError } from './users-service'
import { countActiveUsers, countPendingInvites } from './seats'

export { NotFoundError, SeatLimitError }

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

const inviteInput = z.object({
  email: z.string().email().transform((s) => s.trim().toLowerCase()),
  role: z.enum(USER_ROLES),
})

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export interface PendingInvite {
  id: string
  email: string
  role: string
  expiresAt: Date
  createdAt: Date
}

export interface CreatedInvite {
  id: string
  email: string
  role: string
  /** The invite token — surfaced exactly once (build the /accept-invite link from it). Never stored. */
  token: string
}

export async function inviteUser(
  db: Db, actor: Actor, input: unknown, seatLimit: number, nowMs: number,
): Promise<CreatedInvite> {
  requireCapability(actor, 'user.manage')
  const data = inviteInput.parse(input)
  const token = randomBytes(24).toString('base64url')
  const tokenHash = hashInviteToken(token)

  return db.transaction(async (tx) => {
    const active = await countActiveUsers(tx, actor.orgId)
    const pending = await countPendingInvites(tx, actor.orgId, nowMs)
    if (active + pending >= seatLimit) throw new SeatLimitError()

    const [row] = await tx.insert(invite).values({
      orgId: actor.orgId,
      email: data.email,
      role: data.role,
      tokenHash,
      expiresAt: new Date(nowMs + INVITE_TTL_MS),
    }).returning()

    await writeAudit(tx, {
      orgId: actor.orgId, actor: actor.email, action: 'user.invite',
      target: `invite:${row.id}`, detail: { email: data.email, role: data.role },
    })

    return { id: row.id, email: row.email, role: row.role, token }
  })
}

export async function listPendingInvites(db: Db, actor: Actor, nowMs: number): Promise<PendingInvite[]> {
  requireCapability(actor, 'user.manage')
  return db
    .select({ id: invite.id, email: invite.email, role: invite.role, expiresAt: invite.expiresAt, createdAt: invite.createdAt })
    .from(invite)
    .where(and(eq(invite.orgId, actor.orgId), isNull(invite.acceptedAt), gt(invite.expiresAt, new Date(nowMs))))
    .orderBy(asc(invite.createdAt))
}

export async function revokeInvite(db: Db, actor: Actor, id: string): Promise<void> {
  requireCapability(actor, 'user.manage')
  await db.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(invite)
      .where(and(eq(invite.id, id), eq(invite.orgId, actor.orgId), isNull(invite.acceptedAt)))
      .returning()
    if (!deleted) throw new NotFoundError(`invite ${id}`)
    await writeAudit(tx, {
      orgId: actor.orgId, actor: actor.email, action: 'invite.revoke', target: `invite:${id}`,
    })
  })
}
```

- [ ] **Step 4: Run it — expect pass; typecheck**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/invites-service.test.ts` → PASS (5 tests).
Run: `pnpm -w exec tsc -b` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/server/invites-service.ts apps/control-plane/src/server/invites-service.test.ts
git commit -m "feat(control-plane): invites-service — seat-gated invite (shown-once token) + revoke + list"
```

---

### Task 7: `acceptInvite` — the public token-authenticated user-creation path

The ONLY path that creates a `user` row, so `passwordHash` is never null. Public (no actor) — authenticated by the invite token.

**Files:**
- Modify: `apps/control-plane/src/server/invites-service.ts` (append)
- Modify: `apps/control-plane/src/server/invites-service.test.ts` (append)

**Interfaces:**
- Consumes: `user`, `invite`; `hashPassword` from `../auth/password`; `isRole`; existing invite helpers.
- Produces:
  - `class InviteError extends Error` (reason: `'invalid' | 'expired' | 'accepted'`).
  - `acceptInvite(db, token: string, password: string, nowMs: number): Promise<Actor>` — looks up by `tokenHash`; rejects invalid/expired/already-accepted; inside ONE tx creates the `user` (role from invite, `status='active'`, hashed password), marks `invite.acceptedAt`, audits `user.accept` (actor = the new user's email); returns the `Actor`.

- [ ] **Step 1: Write the failing test**

Append to `apps/control-plane/src/server/invites-service.test.ts`:
```ts
import { acceptInvite, InviteError } from './invites-service'
import { verifyPassword } from '../auth/password'

describe('invites-service acceptInvite', () => {
  test('accepts a valid invite: creates an active user with the invited role + hashed password, marks accepted', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const admin = await seedAdminUser(db, o.id)
    const created = await inviteUser(db, admin, { email: 'new@x.io', role: 'member' }, 5, NOW)

    const actor = await acceptInvite(db, created.token, 'hunter2pass', NOW + 1000)
    expect(actor.email).toBe('new@x.io')
    expect(actor.role).toBe('member')
    expect(actor.orgId).toBe(o.id)

    const [u] = await db.select().from(schema.user).where(eq(schema.user.email, 'new@x.io'))
    expect(u.status).toBe('active')
    expect(u.role).toBe('member')
    expect(await verifyPassword('hunter2pass', u.passwordHash)).toBe(true)
    expect(u.passwordHash).not.toContain('hunter2pass')

    const [inv] = await db.select().from(schema.invite).where(eq(schema.invite.id, created.id))
    expect(inv.acceptedAt).not.toBeNull()

    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'user.accept'))
    expect(audits.length).toBe(1)
  })

  test('rejects invalid, expired, and already-accepted tokens', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const admin = await seedAdminUser(db, o.id)

    await expect(acceptInvite(db, 'not-a-real-token', 'pw12345678', NOW)).rejects.toThrow(InviteError)

    const created = await inviteUser(db, admin, { email: 'e@x.io', role: 'member' }, 5, NOW)
    // expired: nowMs beyond the 7-day TTL
    await expect(acceptInvite(db, created.token, 'pw12345678', NOW + 8 * 24 * 60 * 60 * 1000)).rejects.toThrow(InviteError)

    const good = await inviteUser(db, admin, { email: 'g@x.io', role: 'member' }, 5, NOW)
    await acceptInvite(db, good.token, 'pw12345678', NOW + 1000)
    // second accept of the same token → already accepted
    await expect(acceptInvite(db, good.token, 'pw12345678', NOW + 2000)).rejects.toThrow(InviteError)
  })

  test('rejects a too-short password before creating anything', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const admin = await seedAdminUser(db, o.id)
    const created = await inviteUser(db, admin, { email: 'p@x.io', role: 'member' }, 5, NOW)
    await expect(acceptInvite(db, created.token, 'short', NOW + 1000)).rejects.toThrow()
    const users = await db.select().from(schema.user).where(eq(schema.user.email, 'p@x.io'))
    expect(users.length).toBe(0) // nothing created
  })
})
```

- [ ] **Step 2: Run it — expect fail**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/invites-service.test.ts`
Expected: FAIL — `acceptInvite`/`InviteError` are not exported yet.

- [ ] **Step 3: Implement `acceptInvite`**

Append to `apps/control-plane/src/server/invites-service.ts`:
```ts
import { hashPassword } from '../auth/password'
import { isRole, type Role } from '../auth/authorize'
import { user } from '@metamodels/schema'

export class InviteError extends Error {
  readonly reason: 'invalid' | 'expired' | 'accepted'
  constructor(reason: 'invalid' | 'expired' | 'accepted') {
    super(`invite ${reason}`)
    this.name = 'InviteError'
    this.reason = reason
  }
}

const MIN_PASSWORD_LEN = 8

export async function acceptInvite(db: Db, token: string, password: string, nowMs: number): Promise<Actor> {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LEN) {
    throw new Error(`password must be at least ${MIN_PASSWORD_LEN} characters`)
  }
  const tokenHash = hashInviteToken(token)
  const [inv] = await db.select().from(invite).where(eq(invite.tokenHash, tokenHash)).limit(1)
  if (!inv) throw new InviteError('invalid')
  if (inv.acceptedAt) throw new InviteError('accepted')
  if (inv.expiresAt.getTime() <= nowMs) throw new InviteError('expired')
  const role: Role = isRole(inv.role) ? inv.role : 'viewer'
  const passwordHash = await hashPassword(password)

  return db.transaction(async (tx) => {
    // Re-check acceptance inside the tx so two concurrent accepts of the same token can't both win.
    const [locked] = await tx.select().from(invite).where(and(eq(invite.id, inv.id), isNull(invite.acceptedAt)))
    if (!locked) throw new InviteError('accepted')

    const [u] = await tx.insert(user).values({
      orgId: inv.orgId, email: inv.email, passwordHash, role, status: 'active',
    }).returning()

    await tx.update(invite).set({ acceptedAt: new Date(nowMs) }).where(eq(invite.id, inv.id))

    await writeAudit(tx, {
      orgId: inv.orgId, actor: u.email, action: 'user.accept',
      target: `user:${u.id}`, detail: { role, invite: inv.id },
    })

    return { id: u.id, orgId: u.orgId, email: u.email, role }
  })
}
```
(Consolidate the new imports with the existing ones at the top of the file rather than leaving duplicate `import` lines — `and`, `eq`, `isNull`, `invite`, `writeAudit`, `Db`, `Actor` are already imported; add only `hashPassword`, `isRole`, `type Role`, and `user`.)

- [ ] **Step 4: Run it — expect pass; typecheck**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/invites-service.test.ts` → PASS (5 prior + 3 new).
Run: `pnpm -w exec tsc -b` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/server/invites-service.ts apps/control-plane/src/server/invites-service.test.ts
git commit -m "feat(control-plane): acceptInvite — public token flow creates the user (password never null)"
```

---

### Task 8: `requireCapabilityOr403` page guard (Plan 5.1 carry-forward)

Re-introduce the server-side page guard for admin-only pages (deleted in 5.1 as unwired dead code; now the Team page needs it).

**Files:**
- Modify: `apps/control-plane/src/server/guard.ts`
- Create: `apps/control-plane/src/server/guard.test.ts`

**Interfaces:**
- Consumes: `getCurrentActor`; `authorize`, `type Capability`, `type Actor`; Next `notFound`.
- Produces: `requireCapabilityOr403(cap: Capability): Promise<Actor>` — redirects to `/login` if unauthenticated (via `requireUser`), else if the actor lacks `cap` calls Next `notFound()` (a 404 that does not reveal the page exists); otherwise returns the `Actor`.

- [ ] **Step 1: Write the failing test**

Create `apps/control-plane/src/server/guard.test.ts`:
```ts
import { describe, expect, test, vi, beforeEach } from 'vitest'
import type { Actor } from '../auth/authorize'

const actorRef: { current: Actor | null } = { current: null }
const notFound = vi.fn(() => { throw new Error('NEXT_NOT_FOUND') })
const redirect = vi.fn((to: string) => { throw new Error(`NEXT_REDIRECT:${to}`) })

vi.mock('next/navigation', () => ({ notFound: () => notFound(), redirect: (to: string) => redirect(to) }))
vi.mock('./current-user', () => ({ getCurrentActor: async () => actorRef.current }))

const { requireCapabilityOr403 } = await import('./guard')

beforeEach(() => { actorRef.current = null; notFound.mockClear(); redirect.mockClear() })

describe('requireCapabilityOr403', () => {
  test('redirects to /login when unauthenticated', async () => {
    await expect(requireCapabilityOr403('user.manage')).rejects.toThrow('NEXT_REDIRECT:/login')
  })

  test('calls notFound() when the actor lacks the capability', async () => {
    actorRef.current = { id: 'u', orgId: 'o', email: 'm@x.io', role: 'member' }
    await expect(requireCapabilityOr403('user.manage')).rejects.toThrow('NEXT_NOT_FOUND')
    expect(notFound).toHaveBeenCalledOnce()
  })

  test('returns the actor when authorized', async () => {
    actorRef.current = { id: 'u', orgId: 'o', email: 'a@x.io', role: 'admin' }
    const actor = await requireCapabilityOr403('user.manage')
    expect(actor.email).toBe('a@x.io')
    expect(notFound).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it — expect fail**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/guard.test.ts`
Expected: FAIL — `requireCapabilityOr403` is not exported.

- [ ] **Step 3: Implement in `guard.ts`**

Replace the contents of `apps/control-plane/src/server/guard.ts` with:
```ts
import { notFound, redirect } from 'next/navigation'
import { authorize, type Actor, type Capability } from '../auth/authorize'
import { getCurrentActor } from './current-user'

export async function requireUser(): Promise<Actor> {
  const actor = await getCurrentActor()
  if (!actor) redirect('/login')
  return actor
}

/** Page guard for capability-restricted screens. Unauthenticated → /login; authorized-but-lacking
 *  the capability → 404 (does not reveal the page exists); otherwise returns the Actor. */
export async function requireCapabilityOr403(cap: Capability): Promise<Actor> {
  const actor = await requireUser()
  if (!authorize(actor, cap)) notFound()
  return actor
}
```

- [ ] **Step 4: Run it — expect pass; typecheck**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/guard.test.ts` → PASS (3 tests).
Run: `pnpm -w exec tsc -b` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/server/guard.ts apps/control-plane/src/server/guard.test.ts
git commit -m "feat(control-plane): requireCapabilityOr403 page guard for admin-only screens"
```

---

### Task 9: `/team` screen (admin-only)

**Files:**
- Create: `apps/control-plane/src/app/(app)/team/page.tsx`
- Create: `apps/control-plane/src/app/(app)/team/team-client.tsx`
- Create: `apps/control-plane/src/app/(app)/team/actions.ts`

**Interfaces:**
- Consumes: `requireCapabilityOr403`, `requireUser`; `listUsers`, `changeUserRole`, `setUserStatus`; `inviteUser`, `revokeInvite`, `listPendingInvites`; `getSeatLimit`, `seatUsage`; `getDb`.
- Produces: the `/team` route (nav already links it via `auth/nav.ts`, capability `user.manage`).

This is a UI wiring task — build-verified (`tsc` + `next build`), no new unit tests (the services are already tested). Mirror the structure of `apps/control-plane/src/app/(app)/keys/` (server `page.tsx` → client component + `'use server'` actions returning `{ error?: … }`, `revalidatePath` after each mutation). Reuse existing UI primitives from `apps/control-plane/src/components/ui/` (Button, Input, Label, Drawer, DataTable, StatusPill, plus PageHeader) exactly as the keys/paddocks screens do; do NOT add a new UI dependency.

**Client-form pattern (match `keys-client.tsx` EXACTLY — it does NOT use `useActionState`):** the client component holds `useState` for drawer open, an `error` string, and the one-time invite reveal; the invite form is `<form action={onInvite}>` where `async function onInvite(fd) { const r = await inviteUserAction(null, fd); if (r.error) { setError(r.error); return } … setToken(r.token) }`; each row action is `<form action={async (fd) => { await changeRoleAction(fd) }}>` (and likewise `setStatusAction`, `revokeInviteAction`) — plain form + direct async action call, exactly as `keys-client` wires `createKeyAction`/`revokeKeyAction`.

- [ ] **Step 1: Server actions**

Create `apps/control-plane/src/app/(app)/team/actions.ts`:
```ts
'use server'
import { revalidatePath } from 'next/cache'
import { getDb } from '../../../server/db'
import { requireUser } from '../../../server/guard'
import { requireCapability } from '../../../auth/authorize'
import { isRole } from '../../../auth/authorize'
import { changeUserRole, setUserStatus } from '../../../server/users-service'
import { inviteUser, revokeInvite } from '../../../server/invites-service'
import { getSeatLimit } from '../../../server/seats'

export async function inviteUserAction(
  _prev: unknown, fd: FormData,
): Promise<{ error?: string; token?: string; email?: string }> {
  const actor = await requireUser()
  try {
    requireCapability(actor, 'user.manage')
    const db = getDb()
    const seatLimit = await getSeatLimit(db, actor.orgId)
    const created = await inviteUser(db, actor, {
      email: String(fd.get('email') ?? '').trim(),
      role: String(fd.get('role') ?? 'member'),
    }, seatLimit, Date.now())
    revalidatePath('/team')
    return { token: created.token, email: created.email }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed to invite user' }
  }
}

export async function revokeInviteAction(fd: FormData): Promise<{ error?: string }> {
  const actor = await requireUser()
  try {
    requireCapability(actor, 'user.manage')
    await revokeInvite(getDb(), actor, String(fd.get('id')))
    revalidatePath('/team')
    return {}
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed to revoke invite' }
  }
}

export async function changeRoleAction(fd: FormData): Promise<{ error?: string }> {
  const actor = await requireUser()
  try {
    requireCapability(actor, 'user.manage')
    const role = String(fd.get('role') ?? '')
    if (!isRole(role)) return { error: 'Invalid role' }
    await changeUserRole(getDb(), actor, String(fd.get('id')), role)
    revalidatePath('/team')
    return {}
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed to change role' }
  }
}

export async function setStatusAction(fd: FormData): Promise<{ error?: string }> {
  const actor = await requireUser()
  try {
    requireCapability(actor, 'user.manage')
    const db = getDb()
    const status = String(fd.get('status') ?? '') === 'active' ? 'active' : 'deactivated'
    const seatLimit = await getSeatLimit(db, actor.orgId)
    await setUserStatus(db, actor, String(fd.get('id')), status, seatLimit, Date.now())
    revalidatePath('/team')
    return {}
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed to update user' }
  }
}
```

- [ ] **Step 2: Server page**

Create `apps/control-plane/src/app/(app)/team/page.tsx`:
```tsx
import { requireCapabilityOr403 } from '../../../server/guard'
import { getDb } from '../../../server/db'
import { listUsers } from '../../../server/users-service'
import { listPendingInvites } from '../../../server/invites-service'
import { getSeatLimit, seatUsage } from '../../../server/seats'
import { TeamClient } from './team-client'

export default async function TeamPage() {
  const actor = await requireCapabilityOr403('user.manage')
  const db = getDb()
  const now = Date.now()
  const seatLimit = await getSeatLimit(db, actor.orgId)
  const [users, invites, usage] = await Promise.all([
    listUsers(db, actor),
    listPendingInvites(db, actor, now),
    seatUsage(db, actor, seatLimit, now),
  ])
  return (
    <TeamClient
      selfId={actor.id}
      usage={usage}
      users={users.map((u) => ({ id: u.id, email: u.email, role: u.role, status: u.status, createdAt: u.createdAt.toISOString() }))}
      invites={invites.map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt.toISOString() }))}
    />
  )
}
```

- [ ] **Step 3: Client component**

Create `apps/control-plane/src/app/(app)/team/team-client.tsx` — a `'use client'` component that renders: a header showing `usage.used / usage.limit` seats (and `usage.free` free); an "Invite user" form (email input + role `Select` of `admin|member|viewer`) whose `onInvite(fd)` calls `inviteUserAction(null, fd)` and on success reveals the one-time accept link `\`${location.origin}/accept-invite?token=${token}\`` in a copy-once panel (mirror the `keys-client` secret-reveal `useState` pattern); a users table (email, role, status, created) with a role `Select` (submits `changeRoleAction`) and a Deactivate/Reactivate button (submits `setStatusAction`), with the self row's deactivate disabled (`u.id === selfId`); and a pending-invites list (email, role, expiry) each with a Revoke button (`revokeInviteAction`). Props type:
```ts
interface Usage { used: number; limit: number; free: number }
interface UserItem { id: string; email: string; role: string; status: string; createdAt: string }
interface InviteItem { id: string; email: string; role: string; expiresAt: string }
export function TeamClient(props: { selfId: string; usage: Usage; users: UserItem[]; invites: InviteItem[] }) { /* … */ }
```
Follow the exact client-component conventions already in `apps/control-plane/src/app/(app)/keys/keys-client.tsx` (imports from `../../../components/ui/*`, `useActionState` for the invite form, plain `<form action={…}>` for the row actions). Do NOT import `@metamodels/schema` (server-only barrel — `node:crypto`); the role list is a local `const ROLES = ['admin', 'member', 'viewer'] as const`.

- [ ] **Step 4: Typecheck + build**

Run: `pnpm -w exec tsc -b` → clean.
Run: `pnpm --filter @metamodels/control-plane exec next build --webpack` → succeeds; `/team` present in the route list alongside the existing routes.

- [ ] **Step 5: Commit**

```bash
git add "apps/control-plane/src/app/(app)/team"
git commit -m "feat(control-plane): /team screen — users table, invite drawer, role/status actions, seats header"
```

---

### Task 10: Public `/accept-invite` screen

**Files:**
- Create: `apps/control-plane/src/app/accept-invite/page.tsx`
- Create: `apps/control-plane/src/app/accept-invite/accept-invite-form.tsx`
- Create: `apps/control-plane/src/app/accept-invite/actions.ts`

**Interfaces:**
- Consumes: `acceptInvite` from `../../server/invites-service`; `setSessionCookie` from `../../server/current-user`; `getDb`.
- Produces: the PUBLIC `/accept-invite` route (sibling of `/login`, OUTSIDE the `(app)` group so it is not behind `requireUser`).

Public and token-authenticated — no `requireUser`. On success, sets the session cookie (auto-login) and redirects to `/`.

- [ ] **Step 1: Server action**

Create `apps/control-plane/src/app/accept-invite/actions.ts`:
```ts
'use server'
import { redirect } from 'next/navigation'
import { getDb } from '../../server/db'
import { acceptInvite } from '../../server/invites-service'
import { setSessionCookie } from '../../server/current-user'

export async function acceptInviteAction(_prev: unknown, fd: FormData): Promise<{ error?: string }> {
  const token = String(fd.get('token') ?? '')
  const password = String(fd.get('password') ?? '')
  const confirm = String(fd.get('confirm') ?? '')
  if (password !== confirm) return { error: 'Passwords do not match.' }
  let actor
  try {
    actor = await acceptInvite(getDb(), token, password, Date.now())
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Could not accept this invite.' }
  }
  await setSessionCookie(actor)
  redirect('/')
}
```
Note: `redirect()` throws a control-flow signal — keep it OUTSIDE the try/catch (as above) so it is never swallowed.

- [ ] **Step 2: Server page + client form**

Create `apps/control-plane/src/app/accept-invite/page.tsx`:
```tsx
import { AcceptInviteForm } from './accept-invite-form'

export default async function AcceptInvitePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams
  if (!token) {
    return <main className="p-8 text-sm text-[var(--color-muted)]">This invite link is missing its token.</main>
  }
  return <AcceptInviteForm token={token} />
}
```
Create `apps/control-plane/src/app/accept-invite/accept-invite-form.tsx` — a `'use client'` component with a `useActionState(acceptInviteAction, {})` form containing a hidden `token` input (value from the prop), a `password` field, a `confirm` field, a submit button, and an error line. Mirror the exact structure of `apps/control-plane/src/app/login/` client form (same UI primitives, same `useActionState` shape). It imports the action from `./actions`.

- [ ] **Step 3: Typecheck + build + full suites**

Run: `pnpm -w exec tsc -b` → clean.
Run: `pnpm --filter @metamodels/control-plane exec next build --webpack` → succeeds; `/accept-invite` present as a public route (not under `(app)`).
Run: `pnpm --filter @metamodels/control-plane exec vitest run` → all control-plane tests green (112 baseline + every test added in Tasks 1–8). If the two scrypt tests flake under contention, re-run with `--testTimeout=30000`.
Run: `pnpm test` → root green **189 pass / 3 skip** (unchanged; the invite-schema test runs in the control-plane lane, and no root test was added).

- [ ] **Step 4: Commit**

```bash
git add apps/control-plane/src/app/accept-invite
git commit -m "feat(control-plane): public /accept-invite — set password, create user, auto-login"
```

---

## Self-Review

**Spec coverage (`docs/superpowers/specs/2026-07-27-metamodels-multiuser-licensing-design.md`):**
- §2 roles/authorization — matrix already present; Task 1 binds `Role` to schema `USER_ROLES` so the matrix is exhaustive. `user.manage` gates every user mutation (Tasks 4–7) and the page (Task 8–9). ✓
- §3 multi-user auth — invite-then-accept (`invite` table Task 2; `inviteUser` Task 6; `acceptInvite` Task 7 is the ONLY user-creation path, so `passwordHash` stays NOT NULL). Deactivate/reactivate (Task 5). Dummy-hash login timing fix (Task 3). ✓
- §4 seats — invariant `active + pending ≤ limit` enforced in invite (Task 6) and reactivate (Task 5); `getSeatLimit` = base 1 (Task 4), the single seam 5.7b rewrites; seat-limit rejection messages present. ✓ (Lemon Squeezy activate/validate/deactivate + `entitlement` + grace are explicitly OUT of scope here → Plan 5.7b.)
- §5 schema — additive `invite` table + migration 0004 (Task 2); `user.status`/`USER_ROLES`/`USER_STATUS` already exist (not re-added). `entitlement` table deferred to 5.7b. ✓
- §6 screens — `/team` admin-only (Task 9); role affects nav (already in `auth/nav.ts`) and the Team page is server-guarded (Task 8). The public accept flow (Task 10) is the invitee's entry. *Settings → Upgrade* is 5.7b. ✓
- §8 security/testing — passwords scrypt-hashed, never returned; invite token shown once, only hash stored; `authorize()` is the boundary + page guard; Docker-free pglite tests with real migrations; user create/deactivate/role-change/invite/accept all audited. ✓

**Placeholder scan:** every code step carries complete code except the two UI client components (Task 9 Step 3, Task 10 Step 2), which are described precisely with prop types, the exact sibling files to mirror (`keys-client.tsx`, `login/`), and the primitives to reuse — deliberately not hand-writing full JSX for presentational components whose contract is fully specified and whose only gate is `tsc` + `next build`. The one literal placeholder — `DUMMY_PASSWORD_HASH` — has an exact generation command (Task 3 Step 1) and a format-asserting test. No TBD/TODO remain.

**Type consistency:** `getSeatLimit(db, orgId): Promise<number>` (Task 4) is consumed with that exact shape in Tasks 5, 6, 9. `seatUsage(db, actor, limit, nowMs): Promise<SeatUsage>` (Task 4) matches its use in Task 9. `inviteUser(db, actor, input, seatLimit, nowMs): Promise<CreatedInvite>` (Task 6) matches Task 9's call. `setUserStatus(db, actor, userId, status, seatLimit, nowMs)` (Task 5) matches Task 9. `acceptInvite(db, token, password, nowMs): Promise<Actor>` (Task 7) matches Task 10. `SeatLimitError`/`NotFoundError` are defined in `users-service.ts` and re-exported from `invites-service.ts` so both service test files import them from the module they test. `Role = UserRole` (Task 1) flows into `changeUserRole`'s `role: Role` param (Task 5). ✓

**Decisions flagged for the reviewer:** (1) the seat seam is a numeric `seatLimit` threaded through services with `getSeatLimit` returning base 1 — so 5.7a is intentionally gated at one seat (inviting a real 2nd operator is a 5.7b unlock), and the invite/accept mechanism is fully tested via injected limits; (2) no email delivery in v1 — the invite token is surfaced once and the admin shares the `/accept-invite?token=…` link (mirrors the shown-once API key); (3) user/invite mutations do NOT publish config invalidation (they are not data-plane config); (4) `acceptInvite` re-checks acceptance inside the transaction to make concurrent double-accept safe; (5) the two UI client components are specified-by-contract (mirror existing siblings) rather than hand-coded, gated by `tsc` + `next build`; (6) "last login" from the spec's Team table is omitted (not tracked in the schema) rather than fabricated — data-honesty, consistent with Plan 5.5.
