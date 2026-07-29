# MetaModels Plan 5.7b — Lemon Squeezy License / Entitlement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the seat limit from a hardcoded `1` into a **Lemon Squeezy (LS) licensed** value — an admin activates a license key in *Settings → Upgrade*, the app stores an `entitlement` (encrypted key + instance + seats + status + offline-grace window), re-validates it periodically, and `seats.ts#getSeatLimit` returns the licensed seat count while the license is valid (or within grace) and falls back to base=1 otherwise — **and, because raising the limit above 1 makes the concurrent seat/last-admin races reachable, this plan first installs per-org transactional locking around every seat-consuming and admin-count mutation** (the ★★★ hard requirement from the Plan 5.7a whole-branch review).

**Architecture:** A `license-crypto.ts` encrypts the license key at rest (AES-256-GCM — the key must be recoverable because periodic `/v1/licenses/validate` needs it). An injected-`fetchImpl` `ls-client.ts` wraps LS activate/validate/deactivate (fake-LS tested, no network). `entitlement-service.ts` persists/reads the org's one `entitlement` row; a pure `resolveEntitlementSeats(entitlement, nowMs)` computes the effective seat limit with offline grace. `getSeatLimit` reads through that. `license-service.ts` orchestrates activate/deactivate/revalidate; re-validation is best-effort on login + on-demand from the Upgrade screen. Every seat/admin mutation acquires a per-org `FOR UPDATE` row lock before counting.

**Tech Stack:** TypeScript ESM, Next.js 16.2.0 (App Router, `next build --webpack`), Drizzle/Postgres, Node `crypto` (AES-256-GCM), Vitest + pglite (real migrations, Docker-free) + an injected fake LS `fetchImpl`.

## Global Constraints

- **Node `>=24`; ESM only.** Shared package `@metamodels/schema` uses `.js` import specifiers resolving to `.ts`; the apps do NOT use `.js` specifiers within their own `src`.
- **Additive migration only.** Migrations `0000`–`0004` are frozen. This plan adds exactly one new numbered migration (`0005`) creating the `entitlement` table.
- **No new runtime dependency.** LS is reached via the existing global `fetch` behind an injected `FetchImpl` seam (mirrors the data-plane's `type FetchImpl = (url: string, init: RequestInit) => Promise<Response>` in `apps/data-plane/src/proxy/proxy.ts`); AES-GCM is Node `crypto`. No LS SDK, no HTTP library.
- **License key is NEVER stored or logged in plaintext.** It is encrypted at rest with **AES-256-GCM**; the 32-byte key is derived (`scrypt`/`sha256`) from a required `LICENSE_KEY_SECRET` env (≥16 chars), mirroring how `current-user.ts` reads `SESSION_SECRET`. Store `iv:authTag:ciphertext` (hex) plus a `last4` for display. Re-validation decrypts in-memory only.
- **Offline grace is load-bearing:** a network failure calling LS must NOT revoke entitlement. `revalidate` only downgrades on a DEFINITIVE `valid:false` from LS or when `graceUntil` has passed; a transport error keeps the last-good state until `graceUntil`. `GRACE_MS = 7 days` from `lastValidatedAt`.
- **Determinism:** every function whose logic depends on time takes an injected `nowMs: number` — never call `Date.now()`/`new Date()` for logic inside services (only the action/page layer injects `Date.now()`). This includes `getSeatLimit`, `resolveEntitlementSeats`, `revalidateLicense`, and the invite/seat services.
- **★★★ Per-org locking (Plan 5.7a carry-forward, REQUIRED — not optional):** every mutation that reads a seat/admin count and then mutates (`inviteUser`, `setUserStatus`, `changeUserRole`) MUST acquire a per-org lock (`SELECT id FROM org WHERE id = :orgId FOR UPDATE`) as the FIRST statement inside its transaction, before counting, so concurrent requests serialize per org. Installed in Task 1, before `getSeatLimit` is allowed to exceed 1 (Task 7).
- **`getSeatLimit` seam:** this plan changes its signature to `getSeatLimit(db, orgId, nowMs): Promise<number>` (it now needs the clock for grace). Update its only callers (the `/team` action layer) to inject `Date.now()`.
- **Transactional CRUD template (codebase law):** `requireCapability` + Zod `.parse()` before the tx; inside ONE `db.transaction`: org-scoped read → mutation → `writeAudit(tx, …)`; domain error thrown inside the tx on empty `.returning()`. Copy `keys-service.ts`.
- **Authorization:** license management uses the EXISTING capability `'license.manage'` (admin only, already in the matrix). The `/settings` page is guarded by `requireCapabilityOr403('license.manage')` and each Settings action re-checks server-side. Do NOT invent capability strings.
- **Soft gate, honest:** this is a legitimate upsell, not DRM — no obfuscation, no phone-home beyond the LS calls the operator initiated. AGPL source; patchable.
- **Git identity:** `Carmelo Santana <me@carmelosantana.com>`. Branch: `feat/metamodels-plan5.7b`.
- **Test lanes:** root `pnpm test` (baseline **189 pass / 3 skip**), control-plane `pnpm --filter @metamodels/control-plane exec vitest run` (baseline **138 pass**), workspace typecheck `pnpm -w exec tsc -b`, control-plane `next build --webpack`. Every task keeps them green. (Two pre-existing scrypt tests can time out under CPU contention — re-run the control-plane lane with `--testTimeout=30000`.)

---

## File Structure

```
packages/schema/src/
  schema.ts                                  # MODIFY: + entitlement table
packages/schema/drizzle/
  0005_*.sql + meta/                         # CREATE via drizzle-kit generate: entitlement DDL

apps/control-plane/src/server/
  org-lock.ts                                # CREATE: acquireOrgLock(tx, orgId) — SELECT ... FOR UPDATE
  users-service.ts                           # MODIFY: acquireOrgLock at top of changeUserRole/setUserStatus tx
  invites-service.ts                         # MODIFY: acquireOrgLock in inviteUser tx; + duplicate-invite guard
  license-crypto.ts                          # CREATE: AES-256-GCM encrypt/decrypt + last4
  ls-client.ts                               # CREATE: LemonSqueezyClient (injected fetchImpl) activate/validate/deactivate
  entitlement-service.ts                     # CREATE: get/save/clear entitlement (org-scoped, tx+audit) + resolveEntitlementSeats
  license-service.ts                         # CREATE: activate/deactivate/revalidate orchestration
  seats.ts                                   # MODIFY: getSeatLimit(db, orgId, nowMs) reads entitlement
apps/control-plane/src/server/*.test.ts      # CREATE co-located tests for each new/changed module
apps/control-plane/src/app/login/actions.ts  # MODIFY: best-effort revalidate on successful login
apps/control-plane/src/app/(app)/team/actions.ts  # MODIFY: pass Date.now() into getSeatLimit (2 call sites)
apps/control-plane/src/app/(app)/team/page.tsx    # MODIFY: pass Date.now() into getSeatLimit (3rd call site)
apps/control-plane/src/app/(app)/settings/
  page.tsx                                   # CREATE: Upgrade/License screen (admin-only)
  settings-client.tsx                        # CREATE: activate form + deactivate/revalidate + status display
  actions.ts                                 # CREATE: activate/deactivate/revalidate server actions
```

**Decisions flagged for approval (surfaced here, applied in the tasks):**
1. **Encrypt-at-rest (not hash):** re-validation needs the plaintext key to call LS, so the key is AES-256-GCM encrypted (reversible), not hashed. Requires a new `LICENSE_KEY_SECRET` env. (Alternative — hash + force the operator to re-enter the key on every re-validate — was rejected as bad UX.)
2. **Re-validation cadence = best-effort on login + on-demand button.** A background scheduler is deferred to Plan 6 (needs infra); the offline-grace window covers the gap. On login, re-validation is fire-and-forget (never blocks or fails login).
3. **Seats come from an LS variant→seats map** (`TIER_SEATS`), read from the validate response `meta.variant_name` (fallback to `BASE_SEATS` on an unknown variant). The operator edits `TIER_SEATS` to match their LS store. (LS `activation_limit` is activations, not seats — deliberately not used for seat count.)
4. **Grace window = 7 days** from `lastValidatedAt`.

---

### Task 1: Per-org lock + wire it into every seat/admin mutation (Plan 5.7a carry-forward — REQUIRED)

Install per-org transactional locking BEFORE `getSeatLimit` can exceed 1, so the count-then-mutate races are guarded the moment seats increase.

**Files:**
- Create: `apps/control-plane/src/server/org-lock.ts`
- Create: `apps/control-plane/src/server/org-lock.test.ts`
- Modify: `apps/control-plane/src/server/invites-service.ts` (lock in `inviteUser`)
- Modify: `apps/control-plane/src/server/users-service.ts` (lock in `changeUserRole`, `setUserStatus`)

**Interfaces:**
- Produces: `acquireOrgLock(tx: Db, orgId: string): Promise<void>` — issues `SELECT id FROM "org" WHERE id = <orgId> FOR UPDATE` on the transaction handle. A no-op-visible row lock that serializes concurrent transactions touching the same org.

- [ ] **Step 1: Write the failing test**

Create `apps/control-plane/src/server/org-lock.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import { sql } from 'drizzle-orm'
import * as schema from '@metamodels/schema'
import { freshDb, seedOrg } from '../test/db'
import { acquireOrgLock } from './org-lock'

describe('acquireOrgLock', () => {
  test('locks an existing org row inside a transaction without error', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    await db.transaction(async (tx) => {
      await acquireOrgLock(tx, o.id) // must not throw; row exists
      // still usable afterwards
      const rows = await tx.select().from(schema.org).where(sql`${schema.org.id} = ${o.id}`)
      expect(rows.length).toBe(1)
    })
  })

  test('is a no-op-shaped lock for a missing org (no row to lock, no throw)', async () => {
    const db = await freshDb()
    await db.transaction(async (tx) => {
      await expect(acquireOrgLock(tx, '00000000-0000-0000-0000-000000000000')).resolves.toBeUndefined()
    })
  })
})
```

- [ ] **Step 2: Run it — expect fail**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/org-lock.test.ts`
Expected: FAIL — `Cannot find module './org-lock'`.

- [ ] **Step 3: Implement `org-lock.ts`**

```ts
import { sql } from 'drizzle-orm'
import type { Db } from './db'

/**
 * Take a per-org row lock inside the current transaction so concurrent seat-consuming /
 * admin-count mutations serialize per org. MUST be the first statement in any transaction
 * that reads a seat or active-admin count and then mutates — otherwise two concurrent
 * requests can each read a stale count and both proceed (over-provision seats, or strand an
 * org with zero admins). Locking a missing org row is a harmless no-op.
 */
export async function acquireOrgLock(tx: Db, orgId: string): Promise<void> {
  await tx.execute(sql`SELECT id FROM "org" WHERE id = ${orgId} FOR UPDATE`)
}
```

- [ ] **Step 4: Run it — expect pass**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/org-lock.test.ts` → PASS (2 tests).

- [ ] **Step 5: Wire the lock into the three mutations**

In `invites-service.ts#inviteUser`, make `acquireOrgLock(tx, actor.orgId)` the FIRST statement inside `db.transaction(async (tx) => {` (before `countActiveUsers`). Add the import `import { acquireOrgLock } from './org-lock'`.

In `users-service.ts#changeUserRole` and `#setUserStatus`, make `await acquireOrgLock(tx, actor.orgId)` the FIRST statement inside each `db.transaction(async (tx) => {` (before the org-scoped `select`). Add the same import.

(Do NOT change any other logic; the existing per-task tests must still pass unchanged — the lock is transparent to single-threaded tests.)

- [ ] **Step 6: Run the affected suites + typecheck**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/invites-service.test.ts src/server/users-service.test.ts src/server/org-lock.test.ts` → all green (existing invite/user tests unchanged + 2 new).
Run: `pnpm -w exec tsc -b` → clean.

- [ ] **Step 7: Commit**

```bash
git add apps/control-plane/src/server/org-lock.ts apps/control-plane/src/server/org-lock.test.ts apps/control-plane/src/server/invites-service.ts apps/control-plane/src/server/users-service.ts
git commit -m "feat(control-plane): per-org FOR UPDATE lock on seat/admin mutations (pre-multi-seat race guard)"
```

---

### Task 2: `entitlement` table + migration `0005`

**Files:**
- Modify: `packages/schema/src/schema.ts`
- Create: `packages/schema/drizzle/0005_*.sql` (+ `meta/`) via drizzle-kit
- Create: `apps/control-plane/src/server/entitlement-schema.test.ts`

**Interfaces:**
- Produces: `entitlement` pgTable exported from `@metamodels/schema` — `id` (uuid pk), `orgId` (uuid, FK org cascade, UNIQUE — one entitlement per org), `licenseKeyEnc` (text — `iv:tag:ciphertext`), `licenseLast4` (text), `instanceId` (text), `status` (text), `seats` (integer NOT NULL default 1), `tier` (text), `lastValidatedAt` (timestamptz), `graceUntil` (timestamptz), `createdAt` (timestamptz default now).

- [ ] **Step 1: Add the table to `schema.ts`**

After the `invite` table, add:
```ts
export const entitlement = pgTable('entitlement', {
  id: id(),
  orgId: uuid('org_id').notNull().unique().references(() => org.id, { onDelete: 'cascade' }),
  licenseKeyEnc: text('license_key_enc').notNull(),
  licenseLast4: text('license_last4').notNull(),
  instanceId: text('instance_id'),
  status: text('status').notNull(),
  seats: integer('seats').notNull().default(1),
  tier: text('tier'),
  lastValidatedAt: timestamp('last_validated_at', { withTimezone: true }),
  graceUntil: timestamp('grace_until', { withTimezone: true }),
  createdAt: createdAt(),
})
```
(`integer` is already imported at the top of `schema.ts`; confirm — it is used by `workflowTemplate.cost`/`usageRollup.value`.)

- [ ] **Step 2: Generate the migration**

Run: `pnpm --filter @metamodels/schema exec drizzle-kit generate`
Expected: a new `packages/schema/drizzle/0005_*.sql` with `CREATE TABLE "entitlement"` (+ FK to org, UNIQUE on org_id), a `_journal.json` index-5 entry, and a `0005_snapshot.json`. INSPECT the SQL: it must ONLY create `entitlement` — no ALTER/DROP of `0000`–`0004` tables.

- [ ] **Step 3: Write the migration test**

Create `apps/control-plane/src/server/entitlement-schema.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import * as schema from '@metamodels/schema'
import { freshDb, seedOrg } from '../test/db'

describe('entitlement table (migration 0005)', () => {
  test('freshDb applies 0005 and entitlement round-trips; org_id is unique', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const [row] = await db.insert(schema.entitlement).values({
      orgId: o.id, licenseKeyEnc: 'iv:tag:ct', licenseLast4: 'AB12', status: 'active', seats: 5, tier: 'team',
    }).returning()
    expect(row.orgId).toBe(o.id)
    expect(row.seats).toBe(5)
    expect(row.instanceId).toBeNull()
    expect(row.lastValidatedAt).toBeNull()
    // one entitlement per org
    await expect(db.insert(schema.entitlement).values({
      orgId: o.id, licenseKeyEnc: 'x', licenseLast4: 'CD34', status: 'active',
    }).returning()).rejects.toThrow()
  })
})
```

- [ ] **Step 4: Run it — expect pass; typecheck; both lanes**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/entitlement-schema.test.ts` → PASS.
Run: `pnpm -w exec tsc -b` → clean.
Run: `pnpm test` → root **189 pass / 3 skip** (unchanged; no root test added).

- [ ] **Step 5: Commit**

```bash
git add packages/schema/src/schema.ts packages/schema/drizzle apps/control-plane/src/server/entitlement-schema.test.ts
git commit -m "feat(schema): entitlement table + migration 0005 (one per org, encrypted license key)"
```

---

### Task 3: `license-crypto.ts` — AES-256-GCM encrypt/decrypt at rest

**Files:**
- Create: `apps/control-plane/src/server/license-crypto.ts`
- Create: `apps/control-plane/src/server/license-crypto.test.ts`

**Interfaces:**
- Produces:
  - `encryptLicenseKey(plaintext: string, secret: string): string` — returns `iv(hex):authTag(hex):ciphertext(hex)`.
  - `decryptLicenseKey(stored: string, secret: string): string` — inverse; throws on tamper/format error.
  - `licenseLast4(plaintext: string): string` — last 4 chars (for display).

- [ ] **Step 1: Write the failing test**

Create `apps/control-plane/src/server/license-crypto.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import { encryptLicenseKey, decryptLicenseKey, licenseLast4 } from './license-crypto'

const SECRET = 'test-license-secret-at-least-16-chars'

describe('license-crypto', () => {
  test('encrypt → decrypt round-trips and never contains the plaintext', () => {
    const key = 'ABCD-EFGH-IJKL-MNOP'
    const enc = encryptLicenseKey(key, SECRET)
    expect(enc).not.toContain(key)
    expect(enc.split(':').length).toBe(3)
    expect(decryptLicenseKey(enc, SECRET)).toBe(key)
  })

  test('ciphertext differs each call (random IV) but both decrypt', () => {
    const a = encryptLicenseKey('SAME-KEY', SECRET)
    const b = encryptLicenseKey('SAME-KEY', SECRET)
    expect(a).not.toBe(b)
    expect(decryptLicenseKey(a, SECRET)).toBe('SAME-KEY')
    expect(decryptLicenseKey(b, SECRET)).toBe('SAME-KEY')
  })

  test('decrypt with the wrong secret throws (auth tag mismatch)', () => {
    const enc = encryptLicenseKey('SECRET-KEY', SECRET)
    expect(() => decryptLicenseKey(enc, 'a-different-secret-16chars-long')).toThrow()
  })

  test('decrypt of a tampered ciphertext throws', () => {
    const enc = encryptLicenseKey('SECRET-KEY', SECRET)
    const [iv, tag, ct] = enc.split(':')
    const tampered = `${iv}:${tag}:${ct.slice(0, -2)}00`
    expect(() => decryptLicenseKey(tampered, SECRET)).toThrow()
  })

  test('licenseLast4 returns the last 4 chars', () => {
    expect(licenseLast4('ABCD-EFGH-IJKL-MNOP')).toBe('MNOP')
  })
})
```

- [ ] **Step 2: Run it — expect fail**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/license-crypto.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `license-crypto.ts`**

```ts
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const ALGO = 'aes-256-gcm'

/** Derive a stable 32-byte key from the operator's LICENSE_KEY_SECRET. */
function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest() // 32 bytes
}

/** Encrypt a license key at rest. Output: iv(hex):authTag(hex):ciphertext(hex). */
export function encryptLicenseKey(plaintext: string, secret: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGO, deriveKey(secret), iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`
}

/** Decrypt a stored license key. Throws on format/auth-tag/tamper error. */
export function decryptLicenseKey(stored: string, secret: string): string {
  const parts = stored.split(':')
  if (parts.length !== 3) throw new Error('malformed encrypted license key')
  const [ivHex, tagHex, ctHex] = parts
  const decipher = createDecipheriv(ALGO, deriveKey(secret), Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  const pt = Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()])
  return pt.toString('utf8')
}

export function licenseLast4(plaintext: string): string {
  return plaintext.slice(-4)
}
```

- [ ] **Step 4: Run it — expect pass; typecheck**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/license-crypto.test.ts` → PASS (5 tests).
Run: `pnpm -w exec tsc -b` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/server/license-crypto.ts apps/control-plane/src/server/license-crypto.test.ts
git commit -m "feat(control-plane): license-crypto — AES-256-GCM encrypt-at-rest for the license key"
```

---

### Task 4: `ls-client.ts` — Lemon Squeezy client (injected fetch)

**Files:**
- Create: `apps/control-plane/src/server/ls-client.ts`
- Create: `apps/control-plane/src/server/ls-client.test.ts`

**Interfaces:**
- Produces:
  - `type LsFetch = (url: string, init: RequestInit) => Promise<Response>` (mirrors the data-plane `FetchImpl`).
  - `interface LsResult { valid: boolean; status: string; instanceId: string | null; variantName: string | null }` — the normalized fields this app needs.
  - `class LemonSqueezyClient` with constructor `(opts?: { fetchImpl?: LsFetch; baseUrl?: string })` (defaults: `fetch`, `https://api.lemonsqueezy.com`) and methods:
    - `activate(licenseKey: string, instanceName: string): Promise<LsResult>` — POST `/v1/licenses/activate`.
    - `validate(licenseKey: string, instanceId: string | null): Promise<LsResult>` — POST `/v1/licenses/validate`.
    - `deactivate(licenseKey: string, instanceId: string): Promise<{ deactivated: boolean }>` — POST `/v1/licenses/deactivate`.
  - Transport errors (thrown fetch, non-JSON) propagate as thrown errors so the caller's grace logic can catch them; a well-formed `{ valid: false }` is a normal (non-throwing) result.

- [ ] **Step 1: Write the failing test**

Create `apps/control-plane/src/server/ls-client.test.ts`:
```ts
import { describe, expect, test, vi } from 'vitest'
import { LemonSqueezyClient, type LsFetch } from './ls-client'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('LemonSqueezyClient', () => {
  test('activate posts to /v1/licenses/activate and normalizes the response', async () => {
    const fetchImpl = vi.fn<LsFetch>().mockResolvedValue(jsonResponse({
      activated: true,
      instance: { id: 'inst_123', name: 'my-box' },
      license_key: { status: 'active' },
      meta: { variant_name: 'Team 5' },
    }))
    const client = new LemonSqueezyClient({ fetchImpl })
    const r = await client.activate('LICENSE-KEY', 'my-box')
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://api.lemonsqueezy.com/v1/licenses/activate')
    expect(init.method).toBe('POST')
    expect(String(init.body)).toContain('LICENSE-KEY')
    expect(String(init.body)).toContain('my-box')
    expect(r).toEqual({ valid: true, status: 'active', instanceId: 'inst_123', variantName: 'Team 5' })
  })

  test('validate normalizes valid:false without throwing', async () => {
    const fetchImpl = vi.fn<LsFetch>().mockResolvedValue(jsonResponse({
      valid: false, license_key: { status: 'expired' }, instance: null, meta: { variant_name: 'Team 5' },
    }))
    const client = new LemonSqueezyClient({ fetchImpl })
    const r = await client.validate('LICENSE-KEY', 'inst_123')
    expect(r).toEqual({ valid: false, status: 'expired', instanceId: null, variantName: 'Team 5' })
  })

  test('deactivate returns the deactivated flag', async () => {
    const fetchImpl = vi.fn<LsFetch>().mockResolvedValue(jsonResponse({ deactivated: true }))
    const client = new LemonSqueezyClient({ fetchImpl })
    expect(await client.deactivate('LICENSE-KEY', 'inst_123')).toEqual({ deactivated: true })
  })

  test('a transport error propagates (so grace logic can catch it)', async () => {
    const fetchImpl = vi.fn<LsFetch>().mockRejectedValue(new Error('ECONNREFUSED'))
    const client = new LemonSqueezyClient({ fetchImpl })
    await expect(client.validate('K', 'inst_123')).rejects.toThrow('ECONNREFUSED')
  })
})
```

- [ ] **Step 2: Run it — expect fail**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/ls-client.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `ls-client.ts`**

```ts
export type LsFetch = (url: string, init: RequestInit) => Promise<Response>

export interface LsResult {
  valid: boolean
  status: string
  instanceId: string | null
  variantName: string | null
}

interface LsBody {
  activated?: boolean
  valid?: boolean
  license_key?: { status?: string }
  instance?: { id?: string; name?: string } | null
  meta?: { variant_name?: string }
}

export class LemonSqueezyClient {
  private readonly fetchImpl: LsFetch
  private readonly baseUrl: string

  constructor(opts: { fetchImpl?: LsFetch; baseUrl?: string } = {}) {
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init))
    this.baseUrl = opts.baseUrl ?? 'https://api.lemonsqueezy.com'
  }

  private async post(path: string, form: Record<string, string>): Promise<LsBody> {
    const body = new URLSearchParams(form).toString()
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
    })
    return (await res.json()) as LsBody
  }

  private normalize(b: LsBody): LsResult {
    return {
      valid: b.valid ?? b.activated ?? false,
      status: b.license_key?.status ?? 'unknown',
      instanceId: b.instance?.id ?? null,
      variantName: b.meta?.variant_name ?? null,
    }
  }

  async activate(licenseKey: string, instanceName: string): Promise<LsResult> {
    return this.normalize(await this.post('/v1/licenses/activate', { license_key: licenseKey, instance_name: instanceName }))
  }

  async validate(licenseKey: string, instanceId: string | null): Promise<LsResult> {
    const form: Record<string, string> = { license_key: licenseKey }
    if (instanceId) form.instance_id = instanceId
    return this.normalize(await this.post('/v1/licenses/validate', form))
  }

  async deactivate(licenseKey: string, instanceId: string): Promise<{ deactivated: boolean }> {
    const b = await this.post('/v1/licenses/deactivate', { license_key: licenseKey, instance_id: instanceId })
    return { deactivated: b.deactivated ?? false }
  }
}
```

- [ ] **Step 4: Run it — expect pass; typecheck**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/ls-client.test.ts` → PASS (4 tests).
Run: `pnpm -w exec tsc -b` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/server/ls-client.ts apps/control-plane/src/server/ls-client.test.ts
git commit -m "feat(control-plane): LemonSqueezy client (injected fetch) — activate/validate/deactivate"
```

---

### Task 5: `entitlement-service.ts` — persist/read entitlement + resolve seats

**Files:**
- Create: `apps/control-plane/src/server/entitlement-service.ts`
- Create: `apps/control-plane/src/server/entitlement-service.test.ts`

**Interfaces:**
- Consumes: `entitlement` from `@metamodels/schema`; `type Db`; `writeAudit`; `encryptLicenseKey`/`licenseLast4` (Task 3).
- Produces:
  - `const BASE_SEATS = 1` re-exported from `./seats` (single source) — import it, don't redefine.
  - `const GRACE_MS = 7 * 24 * 60 * 60 * 1000`.
  - `const TIER_SEATS: Record<string, number>` — LS variant name → seats (documented, operator-edited). Default entries e.g. `{ 'Team 5': 5, 'Team 10': 10 }`.
  - `interface EntitlementView { status: string; seats: number; tier: string | null; instanceId: string | null; last4: string; lastValidatedAt: Date | null; graceUntil: Date | null }`
  - `getEntitlement(db, orgId): Promise<EntitlementView | null>` — org-scoped read; NEVER returns the encrypted key.
  - `getDecryptedKey(db, orgId, secret): Promise<string | null>` — server-internal (re-validation only); decrypts in memory.
  - `saveEntitlement(db, actor, input, nowMs, secret): Promise<void>` — encrypt key, upsert the org's one entitlement (`onConflictDoUpdate` on `orgId`), tx + `writeAudit('license.activate')`.
  - `updateValidation(db, orgId, patch, nowMs): Promise<void>` — updates status/seats/instanceId/lastValidatedAt/graceUntil after a (re)validate; no key change.
  - `clearEntitlement(db, actor): Promise<void>` — delete the org's entitlement, tx + `writeAudit('license.deactivate')`.
  - `resolveSeatsForVariant(variantName: string | null): number` — `TIER_SEATS[variantName] ?? BASE_SEATS`.
  - `resolveEntitlementSeats(e: { status: string; seats: number; graceUntil: Date | null }, nowMs): number` — PURE: if `status === 'active'` OR (`graceUntil` && `graceUntil.getTime() > nowMs`) → `e.seats`; else `BASE_SEATS`.

- [ ] **Step 1: Write the failing test**

Create `apps/control-plane/src/server/entitlement-service.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '@metamodels/schema'
import { freshDb, seedOrg, type TestDb } from '../test/db'
import {
  getEntitlement, getDecryptedKey, saveEntitlement, updateValidation, clearEntitlement,
  resolveSeatsForVariant, resolveEntitlementSeats, GRACE_MS,
} from './entitlement-service'
import { decryptLicenseKey } from './license-crypto'
import type { Actor } from '../auth/authorize'

const SECRET = 'entitlement-test-secret-16chars-min'
const NOW = 1_800_000_000_000
const admin = (orgId: string): Actor => ({ id: 'a', orgId, email: 'admin@x.io', role: 'admin' })

describe('entitlement-service', () => {
  test('saveEntitlement encrypts the key (never plaintext), stores last4, and audits', async () => {
    const db = await freshDb(); const o = await seedOrg(db)
    await saveEntitlement(db, admin(o.id), {
      licenseKey: 'ABCD-EFGH-IJKL-WXYZ', instanceId: 'inst_1', status: 'active', seats: 5, tier: 'Team 5',
      lastValidatedAt: new Date(NOW), graceUntil: new Date(NOW + GRACE_MS),
    }, NOW, SECRET)

    const [row] = await db.select().from(schema.entitlement).where(eq(schema.entitlement.orgId, o.id))
    expect(row.licenseKeyEnc).not.toContain('ABCD-EFGH-IJKL-WXYZ')
    expect(row.licenseLast4).toBe('WXYZ')
    expect(row.seats).toBe(5)
    expect(decryptLicenseKey(row.licenseKeyEnc, SECRET)).toBe('ABCD-EFGH-IJKL-WXYZ')

    const view = await getEntitlement(db, o.id)
    expect(view).toMatchObject({ status: 'active', seats: 5, tier: 'Team 5', last4: 'WXYZ' })
    expect((view as unknown as Record<string, unknown>).licenseKeyEnc).toBeUndefined() // never leaks the key

    expect(await getDecryptedKey(db, o.id, SECRET)).toBe('ABCD-EFGH-IJKL-WXYZ')
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'license.activate'))
    expect(audits.length).toBe(1)
  })

  test('saveEntitlement upserts (one row per org)', async () => {
    const db = await freshDb(); const o = await seedOrg(db)
    const base = { licenseKey: 'K1', instanceId: 'i1', status: 'active', seats: 5, tier: 'Team 5', lastValidatedAt: new Date(NOW), graceUntil: new Date(NOW + GRACE_MS) }
    await saveEntitlement(db, admin(o.id), base, NOW, SECRET)
    await saveEntitlement(db, admin(o.id), { ...base, licenseKey: 'K2', seats: 10, tier: 'Team 10' }, NOW, SECRET)
    const rows = await db.select().from(schema.entitlement).where(eq(schema.entitlement.orgId, o.id))
    expect(rows.length).toBe(1)
    expect(rows[0].seats).toBe(10)
  })

  test('updateValidation patches status/seats/grace without touching the key; clearEntitlement removes + audits', async () => {
    const db = await freshDb(); const o = await seedOrg(db)
    await saveEntitlement(db, admin(o.id), { licenseKey: 'K', instanceId: 'i', status: 'active', seats: 5, tier: 'Team 5', lastValidatedAt: new Date(NOW), graceUntil: new Date(NOW + GRACE_MS) }, NOW, SECRET)
    await updateValidation(db, o.id, { status: 'expired', seats: 5, instanceId: 'i', graceUntil: new Date(NOW + GRACE_MS) }, NOW + 1000)
    const v = await getEntitlement(db, o.id)
    expect(v?.status).toBe('expired')
    expect(await getDecryptedKey(db, o.id, SECRET)).toBe('K') // key preserved
    await clearEntitlement(db, admin(o.id))
    expect(await getEntitlement(db, o.id)).toBeNull()
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'license.deactivate'))
    expect(audits.length).toBe(1)
  })

  test('resolveSeatsForVariant maps known variants, falls back to base', () => {
    expect(resolveSeatsForVariant('Team 5')).toBe(5)
    expect(resolveSeatsForVariant('Unknown Plan')).toBe(1)
    expect(resolveSeatsForVariant(null)).toBe(1)
  })

  test('resolveEntitlementSeats: active→seats; expired-but-in-grace→seats; expired-past-grace→base', () => {
    expect(resolveEntitlementSeats({ status: 'active', seats: 5, graceUntil: null }, NOW)).toBe(5)
    expect(resolveEntitlementSeats({ status: 'expired', seats: 5, graceUntil: new Date(NOW + 1000) }, NOW)).toBe(5)
    expect(resolveEntitlementSeats({ status: 'expired', seats: 5, graceUntil: new Date(NOW - 1000) }, NOW)).toBe(1)
    expect(resolveEntitlementSeats({ status: 'expired', seats: 5, graceUntil: null }, NOW)).toBe(1)
  })
})
```

- [ ] **Step 2: Run it — expect fail**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/entitlement-service.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `entitlement-service.ts`**

```ts
import { eq } from 'drizzle-orm'
import { entitlement } from '@metamodels/schema'
import type { Db } from './db'
import { requireCapability, type Actor } from '../auth/authorize'
import { writeAudit } from './audit'
import { encryptLicenseKey, decryptLicenseKey, licenseLast4 } from './license-crypto'
import { BASE_SEATS } from './seats'

export { BASE_SEATS }
export const GRACE_MS = 7 * 24 * 60 * 60 * 1000

/** LS variant name → seat count. Operator edits this to match their Lemon Squeezy store. */
export const TIER_SEATS: Record<string, number> = {
  'Team 5': 5,
  'Team 10': 10,
}

export function resolveSeatsForVariant(variantName: string | null): number {
  if (!variantName) return BASE_SEATS
  return TIER_SEATS[variantName] ?? BASE_SEATS
}

/** PURE: effective seat count. Licensed while active OR within the offline-grace window; else base. */
export function resolveEntitlementSeats(
  e: { status: string; seats: number; graceUntil: Date | null }, nowMs: number,
): number {
  if (e.status === 'active') return e.seats
  if (e.graceUntil && e.graceUntil.getTime() > nowMs) return e.seats
  return BASE_SEATS
}

export interface EntitlementView {
  status: string
  seats: number
  tier: string | null
  instanceId: string | null
  last4: string
  lastValidatedAt: Date | null
  graceUntil: Date | null
}

export async function getEntitlement(db: Db, orgId: string): Promise<EntitlementView | null> {
  const [row] = await db.select({
    status: entitlement.status, seats: entitlement.seats, tier: entitlement.tier,
    instanceId: entitlement.instanceId, last4: entitlement.licenseLast4,
    lastValidatedAt: entitlement.lastValidatedAt, graceUntil: entitlement.graceUntil,
  }).from(entitlement).where(eq(entitlement.orgId, orgId)).limit(1)
  return row ?? null
}

/** Server-internal: decrypt the stored key for a re-validate call. Never exposed to a client. */
export async function getDecryptedKey(db: Db, orgId: string, secret: string): Promise<string | null> {
  const [row] = await db.select({ enc: entitlement.licenseKeyEnc }).from(entitlement).where(eq(entitlement.orgId, orgId)).limit(1)
  return row ? decryptLicenseKey(row.enc, secret) : null
}

export interface SaveEntitlementInput {
  licenseKey: string
  instanceId: string | null
  status: string
  seats: number
  tier: string | null
  lastValidatedAt: Date
  graceUntil: Date
}

export async function saveEntitlement(
  db: Db, actor: Actor, input: SaveEntitlementInput, _nowMs: number, secret: string,
): Promise<void> {
  requireCapability(actor, 'license.manage')
  const licenseKeyEnc = encryptLicenseKey(input.licenseKey, secret)
  const last4 = licenseLast4(input.licenseKey)
  await db.transaction(async (tx) => {
    await tx.insert(entitlement).values({
      orgId: actor.orgId, licenseKeyEnc, licenseLast4: last4, instanceId: input.instanceId,
      status: input.status, seats: input.seats, tier: input.tier,
      lastValidatedAt: input.lastValidatedAt, graceUntil: input.graceUntil,
    }).onConflictDoUpdate({
      target: entitlement.orgId,
      set: {
        licenseKeyEnc, licenseLast4: last4, instanceId: input.instanceId, status: input.status,
        seats: input.seats, tier: input.tier, lastValidatedAt: input.lastValidatedAt, graceUntil: input.graceUntil,
      },
    })
    await writeAudit(tx, {
      orgId: actor.orgId, actor: actor.email, action: 'license.activate',
      target: `entitlement:${actor.orgId}`, detail: { tier: input.tier, seats: input.seats, last4 },
    })
  })
}

export interface ValidationPatch {
  status: string
  seats: number
  instanceId: string | null
  graceUntil: Date
}

/** Update validation state after a (re)validate. Does not touch the encrypted key. Org-scoped, not audited (routine). */
export async function updateValidation(db: Db, orgId: string, patch: ValidationPatch, nowMs: number): Promise<void> {
  await db.update(entitlement).set({
    status: patch.status, seats: patch.seats, instanceId: patch.instanceId,
    lastValidatedAt: new Date(nowMs), graceUntil: patch.graceUntil,
  }).where(eq(entitlement.orgId, orgId))
}

export async function clearEntitlement(db: Db, actor: Actor): Promise<void> {
  requireCapability(actor, 'license.manage')
  await db.transaction(async (tx) => {
    await tx.delete(entitlement).where(eq(entitlement.orgId, actor.orgId))
    await writeAudit(tx, {
      orgId: actor.orgId, actor: actor.email, action: 'license.deactivate', target: `entitlement:${actor.orgId}`,
    })
  })
}
```

- [ ] **Step 4: Run it — expect pass; typecheck**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/entitlement-service.test.ts` → PASS (5 tests).
Run: `pnpm -w exec tsc -b` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/server/entitlement-service.ts apps/control-plane/src/server/entitlement-service.test.ts
git commit -m "feat(control-plane): entitlement-service — encrypted store, seat resolution, offline grace"
```

---

### Task 6: Rewrite `seats.ts#getSeatLimit` to read the entitlement

**Files:**
- Modify: `apps/control-plane/src/server/seats.ts`
- Modify: `apps/control-plane/src/server/seats.test.ts` (append)
- Modify: `apps/control-plane/src/app/(app)/team/actions.ts` (pass `Date.now()` into the new signature — 2 call sites)
- Modify: `apps/control-plane/src/app/(app)/team/page.tsx` (3rd `getSeatLimit` call site)

**Interfaces:**
- Changes: `getSeatLimit(db, orgId, nowMs): Promise<number>` — reads the org's entitlement; returns `resolveEntitlementSeats(entitlement, nowMs)` when one exists, else `BASE_SEATS`.

- [ ] **Step 1: Append the failing test**

Append to `apps/control-plane/src/server/seats.test.ts`:
```ts
import { getSeatLimit } from './seats'
import { saveEntitlement, GRACE_MS } from './entitlement-service'

const SECRET = 'seats-test-secret-at-least-16-chars'

describe('getSeatLimit reads the entitlement', () => {
  const admin = (orgId: string) => ({ id: 'a', orgId, email: 'a@x.io', role: 'admin' as const })

  test('no entitlement → BASE_SEATS (1)', async () => {
    const db = await freshDb(); const o = await seedOrg(db)
    expect(await getSeatLimit(db, o.id, NOW)).toBe(1)
  })

  test('active entitlement → its seats; expired past grace → base', async () => {
    const db = await freshDb(); const o = await seedOrg(db)
    await saveEntitlement(db, admin(o.id), {
      licenseKey: 'K', instanceId: 'i', status: 'active', seats: 5, tier: 'Team 5',
      lastValidatedAt: new Date(NOW), graceUntil: new Date(NOW + GRACE_MS),
    }, NOW, SECRET)
    expect(await getSeatLimit(db, o.id, NOW)).toBe(5)

    // Simulate a definitive expiry with grace already lapsed.
    const { updateValidation } = await import('./entitlement-service')
    await updateValidation(db, o.id, { status: 'expired', seats: 5, instanceId: 'i', graceUntil: new Date(NOW - 1) }, NOW)
    expect(await getSeatLimit(db, o.id, NOW)).toBe(1)
  })
})
```
(`NOW` and the `freshDb`/`seedOrg` imports already exist at the top of `seats.test.ts` from Task 4 of Plan 5.7a.)

- [ ] **Step 2: Run it — expect fail**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/seats.test.ts`
Expected: FAIL — `getSeatLimit` currently ignores `nowMs`/the entitlement and returns `BASE_SEATS`, so the seats=5 case fails.

- [ ] **Step 3: Rewrite `getSeatLimit`**

In `seats.ts`, replace:
```ts
export async function getSeatLimit(_db: Db, _orgId: string): Promise<number> {
  return BASE_SEATS
}
```
with:
```ts
export async function getSeatLimit(db: Db, orgId: string, nowMs: number): Promise<number> {
  const e = await getEntitlement(db, orgId)
  if (!e) return BASE_SEATS
  return resolveEntitlementSeats({ status: e.status, seats: e.seats, graceUntil: e.graceUntil }, nowMs)
}
```
Add the import (NOTE the cycle-avoidance below):
```ts
import { getEntitlement, resolveEntitlementSeats } from './entitlement-service'
```
**Cycle note:** `entitlement-service.ts` imports `BASE_SEATS` from `seats.ts`, and `seats.ts` now imports `getEntitlement`/`resolveEntitlementSeats` from `entitlement-service.ts`. This is a value/function cycle that ESM handles (both modules fully initialize before either function is *called* at request time; `BASE_SEATS` is a top-level const evaluated at import). Confirm `tsc -b` + the tests pass; if the runtime hits a TDZ on `BASE_SEATS`, break the cycle by moving `BASE_SEATS` into a tiny `seat-constants.ts` both import. (Prefer the direct import first; only split if a test actually fails.)

- [ ] **Step 4: Update ALL `getSeatLimit` callers (there are THREE call sites across two files)**

Every call currently passes `(db, actor.orgId)`; add `, Date.now()`:
- `apps/control-plane/src/app/(app)/team/actions.ts` — `inviteUserAction` (line ~18) and `setStatusAction` (line ~62): `getSeatLimit(db, actor.orgId, Date.now())`.
- `apps/control-plane/src/app/(app)/team/page.tsx` — the server page (line ~12): `getSeatLimit(db, actor.orgId, Date.now())` (this page also already builds `seatUsage`; the `Date.now()` it passes there and here can be a single `const now = Date.now()` — optional tidy).

`tsc -b` (Step 5) is the backstop: it fails on any `getSeatLimit(db, orgId)` 2-arg call left unmigrated, so a missed caller cannot slip through.

- [ ] **Step 5: Run it — expect pass; typecheck; suites**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/seats.test.ts` → PASS (5 prior + 2 new).
Run: `pnpm -w exec tsc -b` → clean (this catches any other `getSeatLimit` caller that now needs `nowMs`).
Run: `pnpm --filter @metamodels/control-plane exec vitest run` → full control-plane lane green (the seat/invite/user tests still pass — they pass an explicit `seatLimit` number into the services, unaffected by the `getSeatLimit` signature).

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane/src/server/seats.ts apps/control-plane/src/server/seats.test.ts "apps/control-plane/src/app/(app)/team/actions.ts" "apps/control-plane/src/app/(app)/team/page.tsx"
git commit -m "feat(control-plane): getSeatLimit reads the entitlement (licensed seats + offline grace)"
```

---

### Task 7: `license-service.ts` — activate / deactivate / revalidate orchestration

**Files:**
- Create: `apps/control-plane/src/server/license-service.ts`
- Create: `apps/control-plane/src/server/license-service.test.ts`

**Interfaces:**
- Consumes: `LemonSqueezyClient` (Task 4); entitlement-service (Task 5); `requireCapability`.
- Produces:
  - `licenseSecret(): string` — reads `process.env.LICENSE_KEY_SECRET`, throws if unset/<16 chars (mirrors `current-user.ts#secret`).
  - `activateLicense(db, actor, licenseKey, instanceName, deps): Promise<{ ok: true } | { ok: false; error: string }>` — cap `license.manage`; `ls.activate` → if `valid`, `ls.validate` to confirm + read status; compute seats via `resolveSeatsForVariant`; `saveEntitlement` (status, seats, instanceId, lastValidatedAt=now, graceUntil=now+GRACE_MS). Returns `{ok:false,error}` on `!valid` or a thrown LS error.
  - `deactivateLicense(db, actor, deps): Promise<void>` — cap `license.manage`; best-effort `ls.deactivate` with the decrypted key + stored instanceId (swallow LS errors), then `clearEntitlement`.
  - `revalidateLicense(db, orgId, deps): Promise<void>` — the offline-grace brain: decrypt key; `ls.validate`; on a definitive result `updateValidation` (valid → status from LS + refreshed grace; `!valid` → status from LS, grace unchanged so `resolveEntitlementSeats` downgrades once grace lapses); on a THROWN transport error, do NOTHING (keep last-good state — grace covers it).
  - `deps` shape: `{ ls: LemonSqueezyClient; secret: string; nowMs: number }` (all injected → deterministic + fake-LS testable).

- [ ] **Step 1: Write the failing test**

Create `apps/control-plane/src/server/license-service.test.ts`:
```ts
import { describe, expect, test } from 'vitest'
import { freshDb, seedOrg, type TestDb } from '../test/db'
import { activateLicense, deactivateLicense, revalidateLicense } from './license-service'
import { getEntitlement, GRACE_MS } from './entitlement-service'
import { LemonSqueezyClient, type LsResult } from './ls-client'
import type { Actor } from '../auth/authorize'

const SECRET = 'license-service-secret-16chars-min'
const NOW = 1_800_000_000_000
const admin = (orgId: string): Actor => ({ id: 'a', orgId, email: 'admin@x.io', role: 'admin' })

/** A fake LS built from a per-endpoint script (throw to simulate a transport error). */
function fakeLs(script: { activate?: LsResult; validate?: LsResult | (() => never); deactivate?: { deactivated: boolean } }): LemonSqueezyClient {
  return {
    activate: async () => script.activate!,
    validate: async () => { const v = script.validate; if (typeof v === 'function') return v(); return v! },
    deactivate: async () => script.deactivate ?? { deactivated: true },
  } as unknown as LemonSqueezyClient
}

describe('license-service', () => {
  test('activateLicense stores an active entitlement with tier seats', async () => {
    const db = await freshDb(); const o = await seedOrg(db)
    const ls = fakeLs({
      activate: { valid: true, status: 'active', instanceId: 'inst_1', variantName: 'Team 5' },
      validate: { valid: true, status: 'active', instanceId: 'inst_1', variantName: 'Team 5' },
    })
    const r = await activateLicense(db, admin(o.id), 'LICENSE-KEY', 'my-box', { ls, secret: SECRET, nowMs: NOW })
    expect(r.ok).toBe(true)
    const v = await getEntitlement(db, o.id)
    expect(v).toMatchObject({ status: 'active', seats: 5, tier: 'Team 5', instanceId: 'inst_1' })
    expect(v?.graceUntil?.getTime()).toBe(NOW + GRACE_MS)
  })

  test('activateLicense returns {ok:false} on an invalid key and stores nothing', async () => {
    const db = await freshDb(); const o = await seedOrg(db)
    const ls = fakeLs({ activate: { valid: false, status: 'inactive', instanceId: null, variantName: null } })
    const r = await activateLicense(db, admin(o.id), 'BAD', 'my-box', { ls, secret: SECRET, nowMs: NOW })
    expect(r.ok).toBe(false)
    expect(await getEntitlement(db, o.id)).toBeNull()
  })

  test('revalidate: a transport error keeps the last-good state (offline grace)', async () => {
    const db = await freshDb(); const o = await seedOrg(db)
    const okLs = fakeLs({
      activate: { valid: true, status: 'active', instanceId: 'i', variantName: 'Team 5' },
      validate: { valid: true, status: 'active', instanceId: 'i', variantName: 'Team 5' },
    })
    await activateLicense(db, admin(o.id), 'K', 'box', { ls: okLs, secret: SECRET, nowMs: NOW })

    const downLs = fakeLs({ validate: () => { throw new Error('ECONNREFUSED') } })
    await revalidateLicense(db, o.id, { ls: downLs, secret: SECRET, nowMs: NOW + 1000 })
    const v = await getEntitlement(db, o.id)
    expect(v?.status).toBe('active')                 // unchanged — grace preserves it
    expect(v?.seats).toBe(5)
  })

  test('revalidate: a definitive valid:false downgrades status (grace clock keeps running)', async () => {
    const db = await freshDb(); const o = await seedOrg(db)
    const okLs = fakeLs({
      activate: { valid: true, status: 'active', instanceId: 'i', variantName: 'Team 5' },
      validate: { valid: true, status: 'active', instanceId: 'i', variantName: 'Team 5' },
    })
    await activateLicense(db, admin(o.id), 'K', 'box', { ls: okLs, secret: SECRET, nowMs: NOW })

    const expiredLs = fakeLs({ validate: { valid: false, status: 'expired', instanceId: 'i', variantName: 'Team 5' } })
    await revalidateLicense(db, o.id, { ls: expiredLs, secret: SECRET, nowMs: NOW + 1000 })
    const v = await getEntitlement(db, o.id)
    expect(v?.status).toBe('expired')
    // graceUntil is unchanged from activation, so seats stay licensed until it lapses, then drop.
  })

  test('deactivateLicense clears the entitlement even if LS deactivate fails', async () => {
    const db = await freshDb(); const o = await seedOrg(db)
    const okLs = fakeLs({
      activate: { valid: true, status: 'active', instanceId: 'i', variantName: 'Team 5' },
      validate: { valid: true, status: 'active', instanceId: 'i', variantName: 'Team 5' },
    })
    await activateLicense(db, admin(o.id), 'K', 'box', { ls: okLs, secret: SECRET, nowMs: NOW })
    const downLs = fakeLs({ deactivate: { deactivated: false } })
    await deactivateLicense(db, admin(o.id), { ls: downLs, secret: SECRET, nowMs: NOW + 5 })
    expect(await getEntitlement(db, o.id)).toBeNull()
  })
})
```

- [ ] **Step 2: Run it — expect fail**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/license-service.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `license-service.ts`**

```ts
import type { Db } from './db'
import { requireCapability, type Actor } from '../auth/authorize'
import { LemonSqueezyClient } from './ls-client'
import {
  saveEntitlement, updateValidation, clearEntitlement, getEntitlement, getDecryptedKey,
  resolveSeatsForVariant, GRACE_MS,
} from './entitlement-service'

export interface LicenseDeps {
  ls: LemonSqueezyClient
  secret: string
  nowMs: number
}

/** Read the license-encryption secret from env (>=16 chars), mirroring current-user.ts#secret. */
export function licenseSecret(): string {
  const s = process.env.LICENSE_KEY_SECRET
  if (!s || s.length < 16) throw new Error('LICENSE_KEY_SECRET must be set (>=16 chars)')
  return s
}

export async function activateLicense(
  db: Db, actor: Actor, licenseKey: string, instanceName: string, deps: LicenseDeps,
): Promise<{ ok: true } | { ok: false; error: string }> {
  requireCapability(actor, 'license.manage')
  let res
  try {
    const activated = await deps.ls.activate(licenseKey, instanceName)
    if (!activated.valid) return { ok: false, error: 'License key could not be activated.' }
    // Confirm + read authoritative status/variant.
    res = await deps.ls.validate(licenseKey, activated.instanceId)
    res = { ...res, instanceId: res.instanceId ?? activated.instanceId }
  } catch {
    return { ok: false, error: 'Could not reach the license server. Try again.' }
  }
  const seats = resolveSeatsForVariant(res.variantName)
  await saveEntitlement(db, actor, {
    licenseKey, instanceId: res.instanceId, status: res.status,
    seats, tier: res.variantName, lastValidatedAt: new Date(deps.nowMs), graceUntil: new Date(deps.nowMs + GRACE_MS),
  }, deps.nowMs, deps.secret)
  return { ok: true }
}

export async function deactivateLicense(db: Db, actor: Actor, deps: LicenseDeps): Promise<void> {
  requireCapability(actor, 'license.manage')
  const view = await getEntitlement(db, actor.orgId)
  const key = await getDecryptedKey(db, actor.orgId, deps.secret)
  if (key && view?.instanceId) {
    try { await deps.ls.deactivate(key, view.instanceId) } catch { /* best-effort — clear locally regardless */ }
  }
  await clearEntitlement(db, actor)
}

/**
 * Offline-grace re-validation. A transport error changes NOTHING (grace preserves the last-good
 * state). Only a definitive LS response updates status/seats/instance; a `valid:false` leaves the
 * grace clock as-is so seats stay licensed until graceUntil lapses, then getSeatLimit drops to base.
 */
export async function revalidateLicense(db: Db, orgId: string, deps: LicenseDeps): Promise<void> {
  const key = await getDecryptedKey(db, orgId, deps.secret)
  const view = await getEntitlement(db, orgId)
  if (!key || !view) return
  let res
  try {
    res = await deps.ls.validate(key, view.instanceId)
  } catch {
    return // transport error — keep last-good state; grace covers it
  }
  const seats = res.valid ? resolveSeatsForVariant(res.variantName) : view.seats
  await updateValidation(db, orgId, {
    status: res.status,
    seats,
    instanceId: res.instanceId ?? view.instanceId,
    // On a fresh valid confirmation, extend grace; on valid:false keep the existing grace clock.
    graceUntil: res.valid ? new Date(deps.nowMs + GRACE_MS) : (view.graceUntil ?? new Date(deps.nowMs)),
  }, deps.nowMs)
}
```

- [ ] **Step 4: Run it — expect pass; typecheck**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/license-service.test.ts` → PASS (5 tests).
Run: `pnpm -w exec tsc -b` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/server/license-service.ts apps/control-plane/src/server/license-service.test.ts
git commit -m "feat(control-plane): license-service — activate/deactivate/revalidate with offline grace"
```

---

### Task 8: Best-effort re-validation on login

**Files:**
- Modify: `apps/control-plane/src/app/login/actions.ts`

**Interfaces:**
- Consumes: `revalidateLicense`, `licenseSecret`, `LemonSqueezyClient`.
- Produces: after a SUCCESSFUL `verifyLogin`, fire `revalidateLicense` for the actor's org, fully swallowed (never blocks or fails login; skipped entirely if `LICENSE_KEY_SECRET` is unset).

- [ ] **Step 1: Wire it in**

In `login/actions.ts`, after `await setSessionCookie(result.actor)` and BEFORE `redirect('/')`, insert a best-effort revalidation:
```ts
  // Best-effort license re-validation on login (offline grace covers any failure). Never blocks login.
  try {
    if (process.env.LICENSE_KEY_SECRET) {
      const { revalidateLicense } = await import('../../server/license-service')
      const { LemonSqueezyClient } = await import('../../server/ls-client')
      await revalidateLicense(getDb(), result.actor.orgId, {
        ls: new LemonSqueezyClient(), secret: process.env.LICENSE_KEY_SECRET, nowMs: Date.now(),
      })
    }
  } catch {
    // ignore — login must never fail on license revalidation
  }
```
(`redirect('/')` stays OUTSIDE this try/catch, exactly as today.)

- [ ] **Step 2: Typecheck + build + suites (no new unit test — integration-only, matching the login action's existing untested side effects)**

Run: `pnpm -w exec tsc -b` → clean.
Run: `pnpm --filter @metamodels/control-plane exec next build --webpack` → succeeds.
Run: `pnpm --filter @metamodels/control-plane exec vitest run` → control-plane lane green (the existing login/auth tests are unaffected — the revalidation is a no-op without `LICENSE_KEY_SECRET`, which tests do not set).

- [ ] **Step 3: Commit**

```bash
git add apps/control-plane/src/app/login/actions.ts
git commit -m "feat(control-plane): best-effort license revalidation on login (offline-grace, never blocks)"
```

---

### Task 9: Settings → Upgrade screen (`/settings`)

**Files:**
- Create: `apps/control-plane/src/app/(app)/settings/page.tsx`
- Create: `apps/control-plane/src/app/(app)/settings/settings-client.tsx`
- Create: `apps/control-plane/src/app/(app)/settings/actions.ts`

**Interfaces:**
- Produces: the admin-only `/settings` route (nav already links it via `auth/nav.ts`, capability `license.manage`; the route 404s today). Build-verified, no new unit tests (services already tested).

This is a UI wiring task. Mirror the REAL `keys-client.tsx` `useState` pattern (NOT `useActionState`) — read it first. Reuse existing UI primitives (Button, Input, Label, StatusPill, PageHeader) with the same relative paths keys uses; do NOT import `@metamodels/schema` in the client.

- [ ] **Step 1: Server actions**

Create `apps/control-plane/src/app/(app)/settings/actions.ts`:
```ts
'use server'
import { revalidatePath } from 'next/cache'
import { getDb } from '../../../server/db'
import { requireUser } from '../../../server/guard'
import { requireCapability } from '../../../auth/authorize'
import { activateLicense, deactivateLicense, revalidateLicense, licenseSecret } from '../../../server/license-service'
import { LemonSqueezyClient } from '../../../server/ls-client'

function deps() {
  return { ls: new LemonSqueezyClient(), secret: licenseSecret(), nowMs: Date.now() }
}

export async function activateLicenseAction(_prev: unknown, fd: FormData): Promise<{ error?: string; ok?: boolean }> {
  const actor = await requireUser()
  try {
    requireCapability(actor, 'license.manage')
    const key = String(fd.get('licenseKey') ?? '').trim()
    const instanceName = String(fd.get('instanceName') ?? '').trim() || 'metamodels'
    const r = await activateLicense(getDb(), actor, key, instanceName, deps())
    if (!r.ok) return { error: r.error }
    revalidatePath('/settings')
    return { ok: true }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed to activate license' }
  }
}

export async function deactivateLicenseAction(): Promise<{ error?: string }> {
  const actor = await requireUser()
  try {
    requireCapability(actor, 'license.manage')
    await deactivateLicense(getDb(), actor, deps())
    revalidatePath('/settings')
    return {}
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed to deactivate license' }
  }
}

export async function revalidateLicenseAction(): Promise<{ error?: string }> {
  const actor = await requireUser()
  try {
    requireCapability(actor, 'license.manage')
    await revalidateLicense(getDb(), actor.orgId, deps())
    revalidatePath('/settings')
    return {}
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed to revalidate license' }
  }
}
```

- [ ] **Step 2: Server page**

Create `apps/control-plane/src/app/(app)/settings/page.tsx`:
```tsx
import { requireCapabilityOr403 } from '../../../server/guard'
import { getDb } from '../../../server/db'
import { getEntitlement } from '../../../server/entitlement-service'
import { getSeatLimit, seatUsage } from '../../../server/seats'
import { SettingsClient } from './settings-client'

export default async function SettingsPage() {
  const actor = await requireCapabilityOr403('license.manage')
  const db = getDb()
  const now = Date.now()
  const [ent, limit] = await Promise.all([getEntitlement(db, actor.orgId), getSeatLimit(db, actor.orgId, now)])
  const usage = await seatUsage(db, actor, limit, now)
  return (
    <SettingsClient
      usage={usage}
      entitlement={ent ? {
        status: ent.status, seats: ent.seats, tier: ent.tier, last4: ent.last4,
        lastValidatedAt: ent.lastValidatedAt ? ent.lastValidatedAt.toISOString() : null,
        graceUntil: ent.graceUntil ? ent.graceUntil.toISOString() : null,
      } : null}
    />
  )
}
```

- [ ] **Step 3: Client component**

Create `apps/control-plane/src/app/(app)/settings/settings-client.tsx` — a `'use client'` component mirroring `keys-client.tsx`'s `useState` pattern. Props:
```ts
interface Usage { used: number; limit: number; free: number }
interface EntitlementItem { status: string; seats: number; tier: string | null; last4: string; lastValidatedAt: string | null; graceUntil: string | null }
export function SettingsClient(props: { usage: Usage; entitlement: EntitlementItem | null }) { /* … */ }
```
Render two states:
- **Unlicensed** (`entitlement === null`): a value-proposition blurb + an "Activate license" form (license-key `Input` + optional instance-name `Input`) whose `onActivate(fd)` calls `activateLicenseAction(null, fd)` and shows `r.error` on failure (mirror keys-client's `useState` error handling). Include a plain link to the Lemon Squeezy storefront (a static `https://lemonsqueezy.com` placeholder the operator edits).
- **Licensed**: show tier, `usage.used / usage.limit` seats (and free), status (`StatusPill`), masked key (`•••• {last4}`), last-validated + grace-until (from the ISO strings), a "Re-validate" button (`revalidateLicenseAction`) and a "Deactivate" button (`deactivateLicenseAction`), each a `<form action={async () => { await …Action() }}>`.
Do NOT import `@metamodels/schema`.

- [ ] **Step 4: Typecheck + build**

Run: `pnpm -w exec tsc -b` → clean.
Run: `pnpm --filter @metamodels/control-plane exec next build --webpack` → succeeds; `/settings` present in the route list.

- [ ] **Step 5: Commit**

```bash
git add "apps/control-plane/src/app/(app)/settings"
git commit -m "feat(control-plane): Settings → Upgrade screen — activate/deactivate/revalidate + seat/status display"
```

---

### Task 10: Duplicate-invite guard (Plan 5.7a carry-forward)

Now that seats can exceed 1, reject inviting an email that already belongs to an active user or already has a pending invite (each pending invite reserves a seat; a silent duplicate wastes seats and only fails at accept-time).

**Files:**
- Modify: `apps/control-plane/src/server/invites-service.ts`
- Modify: `apps/control-plane/src/server/invites-service.test.ts` (append)

**Interfaces:**
- Adds: `class DuplicateInviteError extends Error` (re-exported). `inviteUser` throws it when `email` matches an existing active user OR an un-accepted, un-expired invite in the org.

- [ ] **Step 1: Append the failing test**

Append to `apps/control-plane/src/server/invites-service.test.ts`:
```ts
import { DuplicateInviteError } from './invites-service'

describe('inviteUser duplicate guard', () => {
  test('rejects an email that already has a pending invite', async () => {
    const db = await freshDb(); const o = await seedOrg(db)
    const adminA = await seedAdminUser(db, o.id)
    await inviteUser(db, adminA, { email: 'dup@x.io', role: 'member' }, 5, NOW)
    await expect(inviteUser(db, adminA, { email: 'dup@x.io', role: 'member' }, 5, NOW)).rejects.toThrow(DuplicateInviteError)
  })

  test('rejects an email that already belongs to an active user', async () => {
    const db = await freshDb(); const o = await seedOrg(db)
    const adminA = await seedAdminUser(db, o.id)
    await db.insert(schema.user).values({ orgId: o.id, email: 'taken@x.io', passwordHash: 'scrypt$x$y', role: 'member', status: 'active' })
    await expect(inviteUser(db, adminA, { email: 'taken@x.io', role: 'member' }, 5, NOW)).rejects.toThrow(DuplicateInviteError)
  })
})
```
(`seedAdminUser`, `NOW`, `schema` are already in `invites-service.test.ts` from Plan 5.7a Tasks 6–7.)

- [ ] **Step 2: Run it — expect fail**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/invites-service.test.ts` → FAIL (`DuplicateInviteError` not exported).

- [ ] **Step 3: Implement the guard**

In `invites-service.ts`, add the error class near the others:
```ts
export class DuplicateInviteError extends Error {
  constructor(email: string) {
    super(`already invited or a member: ${email}`)
    this.name = 'DuplicateInviteError'
  }
}
```
Inside `inviteUser`'s transaction, AFTER `acquireOrgLock(tx, actor.orgId)` (Task 1) and the seat check, but BEFORE the insert, add:
```ts
    const existingUser = await tx.select({ id: user.id }).from(user)
      .where(and(eq(user.orgId, actor.orgId), eq(user.email, data.email), eq(user.status, 'active'))).limit(1)
    const existingInvite = await tx.select({ id: invite.id }).from(invite)
      .where(and(eq(invite.orgId, actor.orgId), eq(invite.email, data.email), isNull(invite.acceptedAt), gt(invite.expiresAt, new Date(nowMs)))).limit(1)
    if (existingUser.length || existingInvite.length) throw new DuplicateInviteError(data.email)
```
Add `user` to the `@metamodels/schema` import (it may already be imported after Task 7's acceptInvite; consolidate, no duplicate). `and`/`eq`/`isNull`/`gt` are already imported.

- [ ] **Step 4: Run it — expect pass; typecheck**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/invites-service.test.ts` → PASS (prior + 2 new).
Run: `pnpm -w exec tsc -b` → clean.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/server/invites-service.ts apps/control-plane/src/server/invites-service.test.ts
git commit -m "feat(control-plane): reject duplicate invites (active user or pending invite) — pre-multi-seat"
```

---

### Task 11: Full-suite + build verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck**

Run: `pnpm -w exec tsc -b` → clean.

- [ ] **Step 2: Control-plane suite + build**

Run: `pnpm --filter @metamodels/control-plane exec vitest run --testTimeout=30000` → all green (138 baseline + every test added in Tasks 1–10). Record the count.
Run: `pnpm --filter @metamodels/control-plane exec next build --webpack` → succeeds; `/settings` present alongside all existing routes.

- [ ] **Step 3: Root suite**

Run: `pnpm test` → root green **189 pass / 3 skip** (unchanged — all new tests are in the control-plane lane; the two new migrations run inside pglite there).

- [ ] **Step 4: Commit (if any incidental fixes were needed; otherwise skip)**

No file changes expected in this task; it is the whole-plan gate before the branch review.

---

## Self-Review

**Spec coverage (`docs/superpowers/specs/2026-07-27-metamodels-multiuser-licensing-design.md` §4–5, §8):**
- §4 upgrade flow — `activateLicense` calls LS activate → validate → stores `entitlement` with derived seats (Task 7); *Settings → Upgrade* (Task 9). ✓
- §4 enforcement — `getSeatLimit` returns licensed seats (Task 6); the seat invariant + per-org lock (Task 1) keep it correct under concurrency once seats > 1. ✓
- §4 resilience / offline grace — `revalidateLicense` keeps last-good on transport error, downgrades only on definitive `valid:false` or grace lapse (Task 7); `resolveEntitlementSeats` (Task 5). ✓
- §4 deactivate — `deactivateLicense` calls LS deactivate then clears locally even on failure (Task 7). ✓
- §5 schema — additive `entitlement` table + migration 0005, one per org (Task 2). ✓
- §8 security — key AES-256-GCM encrypted at rest, never logged/returned (Tasks 3, 5); LS behind injected `fetchImpl`, Docker-free fake-LS tests (Tasks 4, 7); license activate/deactivate audited (Task 5); seat enforcement server-side. ✓
- **Plan 5.7a carry-forward** — per-org `FOR UPDATE` lock installed before seats can exceed 1 (Task 1); duplicate-invite guard (Task 10). ✓

**Placeholder scan:** every code step carries complete code except the two UI client components (Task 9 Step 3 client is specified-by-contract, mirroring `keys-client.tsx` with exact prop types — same approach the shipped 5.5/5.7a UI tasks used, gated by `tsc` + `next build`). No TBD/TODO.

**Type consistency:** `getSeatLimit(db, orgId, nowMs)` (Task 6) is called with `Date.now()` in Task 6's caller edit and Task 9's page. `LsResult`/`LemonSqueezyClient` (Task 4) are consumed by `license-service` (Task 7) and the fake in its test. `SaveEntitlementInput`/`EntitlementView`/`resolveEntitlementSeats` (Task 5) match their uses in Tasks 6–7 and the page. `LicenseDeps { ls, secret, nowMs }` is identical across `activate/deactivate/revalidate` (Task 7) and the Settings actions' `deps()` (Task 9). `acquireOrgLock(tx, orgId)` (Task 1) is called in invites/users services with a `tx`. ✓

**Decisions flagged for the reviewer:** (1) key encrypted-at-rest (reversible) because re-validation needs plaintext — new `LICENSE_KEY_SECRET` env; (2) re-validation is on-login + on-demand, no scheduler (Plan 6); (3) seats via a `TIER_SEATS` variant map with a base fallback; (4) grace = 7 days; (5) the seats↔entitlement module import is a value/function cycle ESM tolerates — split `BASE_SEATS` into `seat-constants.ts` only if a runtime TDZ actually appears; (6) per-org lock installed in Task 1 (before Task 6 raises the limit) so the multi-seat races are guarded from the moment they become reachable; (7) UI client specified-by-contract (mirror `keys-client`), gated by build.
