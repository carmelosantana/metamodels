# MetaModels Plan 5.2 — Paddocks + Fences — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator publish a fenced Paddock end-to-end — create a Paddock on one of their Flocks (org-consistent, unique slug, live `/p/:slug`, status toggle, plain↔MetaBoy theme), and author its breed-aware Fence (constraint validated on write, `mutate` hard-locked, model allowlist, rate limit + quota, Blast-Radius summary) — screens 9b + 9c.

**Architecture:** Extends the `apps/control-plane` app built in Plan 5.1. Business logic goes in Next-free, vitest+pglite-tested modules; the RSC pages/Server Actions are thin shells. **Every mutating service copies the Plan 5.1 CRUD template verbatim: `requireCapability → Zod parse → org-scope → mutation + writeAudit in ONE `db.transaction``.** Fence `constraint_json` is validated against the paddock's breed `constraintSchema` (from `@metamodels/connectors`) on write; `rate_limit`/`quota` are validated with local Zod schemas mirroring the data-plane's. A new additive migration adds `paddock.theme` and a one-fence-per-paddock unique index.

**Tech Stack:** Next.js 16.2 (App Router, RSC + Server Actions, webpack build per 5.1), Drizzle ORM + Postgres (pglite in tests), Zod, `@metamodels/schema` + `@metamodels/connectors`, vitest.

## Global Constraints

- **Node** `>=24`; ESM only. Reuse the Plan 5.1 app — **add no new dependencies** (Zod, drizzle, connectors, pglite already present).
- **Copy the 5.1 CRUD template exactly:** `requireCapability(actor, cap)` → `zodSchema.parse(input)` → org-scoped query → **mutation + `writeAudit(tx, …)` inside a single `db.transaction(async (tx) => {…})`**. `NotFoundError` is thrown INSIDE the transaction on an empty `.returning()` (so a not-found/cross-org mutation rolls back and writes no audit row). Capability + Zod run BEFORE the transaction. Reuse the existing `NotFoundError` from `apps/control-plane/src/server/flocks-service.ts` — do not redefine it.
- **`authorize()` is the boundary.** Reads require `read`; writes require `resource.write`. UI hiding is convenience only; every write server action re-checks `requireCapability` server-side.
- **Org-scoping is mandatory and cross-cutting:**
  - A Paddock may only reference a Flock in the **same org** (`paddock.flockId` must resolve to a flock with `orgId === actor.orgId`; otherwise `NotFoundError`). This is the **key↔paddock org-consistency groundwork** (the key↔paddock half lands in Plan 5.4).
  - A Fence is reached only via its Paddock; load the paddock scoped to `actor.orgId` before touching the fence. Fence rows carry `orgId = actor.orgId` (denormalized, matches the data-plane).
  - Every list/read query filters by `actor.orgId`; every update/delete matches `and(eq(id), eq(orgId))`.
- **`mutate` is hard-locked — never exposable.** Ollama's `constraintSchema` (`ollamaConstraint`) only permits `allowedRoutes` from `['chat','generate','embed','read']` — there is no `mutate` value, so a fence structurally cannot expose model-management routes. Do not add one. The Fence editor UI shows `mutate` as a permanently-locked row. (The data-plane also hard-blocks `mutate` at request time regardless.)
- **Fence validation on write:** `constraint_json` MUST be parsed with the paddock's breed `constraintSchema` (`registry.get(breedId).constraintSchema`) and rejected on failure. `rate_limit` and `quota` MUST be validated with the local `rateLimitSchema`/`quotaSchema` (shapes identical to the data-plane's `RateLimit` `{windowSec,max}` and `quotaSchema` `[{dim,max,period}]`). This removes the data-plane's fail-open-on-malformed-quota risk at the source.
- **Migrations additive only.** `0000`/`0001`/`0002` frozen; new numbered migration. Regenerate via `drizzle-kit generate`, never hand-edit.
- **Herding vocabulary:** Paddock (published endpoint), Fence (policy), Flock (upstream). Field names map 1:1 to `packages/schema/src/schema.ts`. Slugs are the public `/p/:slug` handle.
- **Design reference:** operator-mode screens `9b Paddocks` (`docs/design_v2/screenshots/9b-paddocks.png` — Paddock cards, status switch, disabled dimmed, New-paddock panel with live `/p/:slug` preview) and `9c Fence editor` (`docs/design_v2/screenshots/9c-fence-editor.png` — RouteClassRows read/infer on, **mutate permanently locked**, model allowlist chips, rate limit + quota, BlastRadiusCard). Reuse the Plan 5.1 primitives (`Button`, `Input`, `Label`, `Select`, `Switch`, `Drawer`, `DataTable`, `StatusPill`, `BreedChip`, `PageHeader`, `cn`, operator-mode CSS tokens). Hand-authored, no new UI deps.
- **ComfyUI fence templates are OUT of scope here** — the ComfyUI constraint (`templates`) is authored in the ★ paramSchema editor (Plan 5.3). In 5.2 the Fence editor's constraint UI targets **Ollama** (routes + models); for a ComfyUI paddock it shows a "templates are managed in the Template editor (coming in 5.3)" note but still edits rate limit + quota. The `fences-service` validation handles BOTH breeds generically.

---

## File Structure

**New in `apps/control-plane/`:**

| Path | Responsibility |
|---|---|
| `src/lib/paddock-schema.ts` | Zod `savePaddockInput` (id?/flockId/name/slug/status/theme). **Tested.** |
| `src/lib/fence-schema.ts` | Zod `rateLimitSchema`, `quotaSchema`, `saveFenceInput`. **Tested.** |
| `src/server/paddocks-service.ts` | `listPaddocks` / `savePaddock` / `deletePaddock` / `setPaddockStatus` — CRUD template + flock-org-consistency + slug-uniqueness. **Tested (pglite).** |
| `src/server/fence-validation.ts` | `validateConstraintForBreed(registry, breedId, constraintJson)` — parse against breed `constraintSchema`. **Tested.** |
| `src/server/fences-service.ts` | `getFence(paddockId)` / `saveFence(registry, input)` — validate + one-fence-per-paddock upsert, org-scoped via paddock, audited. **Tested (pglite).** |
| `src/server/blast-radius.ts` | `computeBlastRadius(breedId, constraintJson, rateLimit, quota)` — pure summary for the BlastRadiusCard. **Tested.** |
| `src/app/(app)/paddocks/page.tsx`, `.../actions.ts`, `.../paddocks-client.tsx` | Screen 9b (thin glue). |
| `src/app/(app)/paddocks/[id]/fence/page.tsx`, `.../actions.ts`, `.../fence-client.tsx` | Screen 9c (thin glue). |
| `src/components/ui/blast-radius-card.tsx` | Presentational BlastRadiusCard. |

**Modified `packages/schema/`:** `src/schema.ts` (add `paddock.theme`; add `fence_paddock` unique index), `src/enums.ts` (add `PADDOCK_THEMES`), `drizzle/0003_*.sql` + `meta/*` (generated), `test/schema.test.ts` (add cases).

**Modified `apps/control-plane/`:** `src/components/app-sidebar.tsx` is unchanged (the Paddocks nav item already exists from Plan 5.1); `src/app/(app)/flocks/page.tsx` unchanged.

**Testing note:** reuse the Plan 5.1 pglite helper `apps/control-plane/src/test/db.ts` (`freshDb`, `seedOrg`). A recurring test fixture is "an org with a flock" — build it inline per test. The control-plane suite runs under `apps/control-plane/vitest.config.ts`; the schema suite runs under the repo root. Both must stay green.

---

## Task 1: Schema — `paddock.theme` + one-fence-per-paddock index

**Files:**
- Modify: `packages/schema/src/schema.ts`, `packages/schema/src/enums.ts`
- Create: `packages/schema/drizzle/0003_*.sql` + `meta/*` (generated)
- Test: `packages/schema/test/schema.test.ts`

**Interfaces:**
- Produces: `paddock.theme text NOT NULL DEFAULT 'plain'` (`plain` | `metaboy`); `PADDOCK_THEMES = ['plain','metaboy']` (+ `PaddockTheme` type); a unique index `fence_paddock` on `fence.paddockId` (enforces one Fence per Paddock, enabling `onConflictDoUpdate`).
- Consumed by: `paddock-schema.ts` (Task 2), `fences-service.ts` (Task 5).

- [ ] **Step 1: Write the failing test**

Add to `packages/schema/test/schema.test.ts` inside the `describe('schema', …)` block:

```ts
test('paddock.theme defaults to plain and accepts metaboy', async () => {
  const db = await freshMigratedDb()
  const [o] = await db.insert(schema.org).values({ name: 'o' }).returning()
  const [f] = await db.insert(schema.flock).values({ orgId: o.id, breed: 'ollama', name: 'f', baseUrl: 'http://x' }).returning()
  const [p1] = await db.insert(schema.paddock).values({ orgId: o.id, flockId: f.id, slug: 'th-a', name: 'A' }).returning()
  expect(p1.theme).toBe('plain')
  const [p2] = await db.insert(schema.paddock).values({ orgId: o.id, flockId: f.id, slug: 'th-b', name: 'B', theme: 'metaboy' }).returning()
  expect(p2.theme).toBe('metaboy')
})

test('fence table allows only one fence per paddock', async () => {
  const db = await freshMigratedDb()
  const [o] = await db.insert(schema.org).values({ name: 'o' }).returning()
  const [f] = await db.insert(schema.flock).values({ orgId: o.id, breed: 'ollama', name: 'f', baseUrl: 'http://x' }).returning()
  const [p] = await db.insert(schema.paddock).values({ orgId: o.id, flockId: f.id, slug: 'fp', name: 'P' }).returning()
  await db.insert(schema.fence).values({ orgId: o.id, paddockId: p.id, constraintJson: {} })
  await expect(db.insert(schema.fence).values({ orgId: o.id, paddockId: p.id, constraintJson: {} })).rejects.toThrow()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/schema/test/schema.test.ts`
Expected: FAIL — `theme` missing on the insert type; second fence insert does NOT throw (no unique index yet).

> Note: the schema package has no own vitest config, so run it from the repo root with the file path (not `pnpm --filter @metamodels/schema exec vitest`, which finds no files).

- [ ] **Step 3: Add the column, enum, and unique index**

In `packages/schema/src/schema.ts`, add `theme` to `paddock` (after `status`):

```ts
export const paddock = pgTable('paddock', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  flockId: uuid('flock_id').notNull().references(() => flock.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  status: text('status').notNull().default('active'),
  theme: text('theme').notNull().default('plain'),
  createdAt: createdAt(),
})
```

Change the `fence` table to add the unique index (array-return extras form):

```ts
export const fence = pgTable('fence', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  paddockId: uuid('paddock_id').notNull().references(() => paddock.id, { onDelete: 'cascade' }),
  constraintJson: jsonb('constraint_json').notNull(),
  rateLimit: jsonb('rate_limit'),
  quota: jsonb('quota'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('fence_paddock').on(t.paddockId),
])
```

`uniqueIndex` is already imported at the top of `schema.ts` (used by `usage_rollup`). In `packages/schema/src/enums.ts`, add:

```ts
export const PADDOCK_THEMES = ['plain', 'metaboy'] as const
export type PaddockTheme = (typeof PADDOCK_THEMES)[number]
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm --filter @metamodels/schema exec drizzle-kit generate`
Expected: creates `packages/schema/drizzle/0003_*.sql` with `ALTER TABLE "paddock" ADD COLUMN "theme" text DEFAULT 'plain' NOT NULL;` and `CREATE UNIQUE INDEX "fence_paddock" ON "fence" USING btree ("paddock_id");` and updates `meta/`. Inspect it: it must be purely additive (one ADD COLUMN + one CREATE UNIQUE INDEX), `0000`–`0002` untouched, `_journal.json` appends only a `0003` entry.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm exec vitest run packages/schema/test/schema.test.ts`
Expected: PASS (existing + 2 new cases).

- [ ] **Step 6: Commit**

```bash
git add packages/schema/src/schema.ts packages/schema/src/enums.ts packages/schema/drizzle packages/schema/test/schema.test.ts
git commit -m "feat(schema): add paddock.theme + one-fence-per-paddock unique index"
```

---

## Task 2: Paddock schema + service (list / save / delete / setStatus)

**Files:**
- Create: `apps/control-plane/src/lib/paddock-schema.ts`
- Create: `apps/control-plane/src/server/paddocks-service.ts`
- Test: `apps/control-plane/src/server/paddocks-service.test.ts`

**Interfaces:**
- Produces:
  - `savePaddockInput` → `{ id?: string; flockId: string; name: string; slug: string; status: 'active'|'disabled'; theme: 'plain'|'metaboy' }`
  - `class SlugTakenError extends Error`
  - `listPaddocks(db, actor): Promise<Paddock[]>` (org-scoped; `read`)
  - `savePaddock(db, actor, input): Promise<Paddock>` (`resource.write`; flock must be in org else `NotFoundError`; slug globally unique else `SlugTakenError`; audits `paddock.create`/`paddock.update`)
  - `deletePaddock(db, actor, id): Promise<void>` (`resource.write`; org-scoped; audits `paddock.delete`)
  - `setPaddockStatus(db, actor, id, status): Promise<Paddock>` (`resource.write`; org-scoped; audits `paddock.status`)
- Consumes: `NotFoundError` (from `./flocks-service`), `requireCapability`/`Actor`, `writeAudit`, `paddock`/`flock`/`Paddock`, `PADDOCK_STATUS`/`PADDOCK_THEMES`.

- [ ] **Step 1: Write the failing test**

`apps/control-plane/src/server/paddocks-service.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '@metamodels/schema'
import { freshDb, seedOrg } from '../test/db'
import { listPaddocks, savePaddock, deletePaddock, setPaddockStatus, SlugTakenError } from './paddocks-service'
import { NotFoundError } from './flocks-service'
import { ForbiddenError, type Actor } from '../auth/authorize'

type TDb = Awaited<ReturnType<typeof freshDb>>

async function orgWithFlock(db: TDb, role: Actor['role'] = 'admin') {
  const o = await seedOrg(db)
  const [f] = await db.insert(schema.flock).values({ orgId: o.id, breed: 'ollama', name: 'f', baseUrl: 'http://x' }).returning()
  const actor: Actor = { id: 'u1', orgId: o.id, email: `${role}@x.io`, role }
  return { o, f, actor }
}

describe('paddocks-service', () => {
  test('member creates a paddock on an org flock; org-scoped + audited', async () => {
    const db = await freshDb()
    const { f, actor } = await orgWithFlock(db, 'member')
    const p = await savePaddock(db, actor, { flockId: f.id, name: 'Small', slug: 'small', status: 'active', theme: 'plain' })
    expect(p.orgId).toBe(actor.orgId)
    expect(p.slug).toBe('small')
    expect(p.theme).toBe('plain')
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'paddock.create'))
    expect(audits).toHaveLength(1)
    expect(audits[0].actor).toBe('member@x.io')
  })

  test('viewer cannot create (ForbiddenError), nothing written', async () => {
    const db = await freshDb()
    const { f, actor } = await orgWithFlock(db, 'viewer')
    await expect(savePaddock(db, actor, { flockId: f.id, name: 'x', slug: 'x', status: 'active', theme: 'plain' }))
      .rejects.toThrow(ForbiddenError)
    expect(await db.select().from(schema.paddock)).toHaveLength(0)
  })

  test('cannot attach a paddock to a flock in another org (NotFoundError)', async () => {
    const db = await freshDb()
    const { actor } = await orgWithFlock(db)
    const [otherOrg] = await db.insert(schema.org).values({ name: 'other' }).returning()
    const [foreignFlock] = await db.insert(schema.flock).values({ orgId: otherOrg.id, breed: 'ollama', name: 'ff', baseUrl: 'http://y' }).returning()
    await expect(savePaddock(db, actor, { flockId: foreignFlock.id, name: 'hj', slug: 'hj', status: 'active', theme: 'plain' }))
      .rejects.toThrow(NotFoundError)
    expect(await db.select().from(schema.paddock)).toHaveLength(0)
  })

  test('duplicate slug is rejected with SlugTakenError, not a raw DB error', async () => {
    const db = await freshDb()
    const { f, actor } = await orgWithFlock(db)
    await savePaddock(db, actor, { flockId: f.id, name: 'A', slug: 'dup', status: 'active', theme: 'plain' })
    await expect(savePaddock(db, actor, { flockId: f.id, name: 'B', slug: 'dup', status: 'active', theme: 'plain' }))
      .rejects.toThrow(SlugTakenError)
    expect(await db.select().from(schema.paddock)).toHaveLength(1)
  })

  test('invalid slug shape is rejected before any write', async () => {
    const db = await freshDb()
    const { f, actor } = await orgWithFlock(db)
    await expect(savePaddock(db, actor, { flockId: f.id, name: 'A', slug: 'Not A Slug', status: 'active', theme: 'plain' }))
      .rejects.toThrow()
    expect(await db.select().from(schema.paddock)).toHaveLength(0)
  })

  test('update changes fields within the org; list is org-scoped', async () => {
    const db = await freshDb()
    const { f, actor } = await orgWithFlock(db)
    const created = await savePaddock(db, actor, { flockId: f.id, name: 'A', slug: 'a', status: 'active', theme: 'plain' })
    const updated = await savePaddock(db, actor, { id: created.id, flockId: f.id, name: 'A2', slug: 'a', status: 'active', theme: 'metaboy' })
    expect(updated.id).toBe(created.id)
    expect(updated.name).toBe('A2')
    expect(updated.theme).toBe('metaboy')
    expect(await listPaddocks(db, actor)).toHaveLength(1)
  })

  test('cannot update or delete a paddock in another org', async () => {
    const db = await freshDb()
    const { actor } = await orgWithFlock(db)
    const [otherOrg] = await db.insert(schema.org).values({ name: 'other' }).returning()
    const [oFlock] = await db.insert(schema.flock).values({ orgId: otherOrg.id, breed: 'ollama', name: 'of', baseUrl: 'http://z' }).returning()
    const [foreign] = await db.insert(schema.paddock).values({ orgId: otherOrg.id, flockId: oFlock.id, slug: 'foreign', name: 'F' }).returning()
    await expect(deletePaddock(db, actor, foreign.id)).rejects.toThrow(NotFoundError)
    await expect(setPaddockStatus(db, actor, foreign.id, 'disabled')).rejects.toThrow(NotFoundError)
    const [still] = await db.select().from(schema.paddock).where(eq(schema.paddock.id, foreign.id))
    expect(still.status).toBe('active')
  })

  test('setPaddockStatus toggles status and audits it', async () => {
    const db = await freshDb()
    const { f, actor } = await orgWithFlock(db)
    const p = await savePaddock(db, actor, { flockId: f.id, name: 'A', slug: 'a', status: 'active', theme: 'plain' })
    const disabled = await setPaddockStatus(db, actor, p.id, 'disabled')
    expect(disabled.status).toBe('disabled')
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'paddock.status'))
    expect(audits).toHaveLength(1)
    expect(audits[0].detail).toMatchObject({ status: 'disabled' })
  })

  test('delete removes an org paddock and audits it', async () => {
    const db = await freshDb()
    const { f, actor } = await orgWithFlock(db)
    const p = await savePaddock(db, actor, { flockId: f.id, name: 'A', slug: 'a', status: 'active', theme: 'plain' })
    await deletePaddock(db, actor, p.id)
    expect(await db.select().from(schema.paddock)).toHaveLength(0)
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'paddock.delete'))
    expect(audits).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/paddocks-service.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the schema**

`apps/control-plane/src/lib/paddock-schema.ts`:

```ts
import { z } from 'zod'
import { PADDOCK_STATUS, PADDOCK_THEMES } from '@metamodels/schema'

// Public /p/:slug handle: lowercase letters, digits, hyphens; no leading/trailing hyphen.
const slug = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'slug must be lowercase letters, digits, and hyphens')

export const savePaddockInput = z.object({
  id: z.string().uuid().optional(),
  flockId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  slug,
  status: z.enum(PADDOCK_STATUS).default('active'),
  theme: z.enum(PADDOCK_THEMES).default('plain'),
})

export type SavePaddockInput = z.infer<typeof savePaddockInput>
```

- [ ] **Step 4: Implement the service**

`apps/control-plane/src/server/paddocks-service.ts`:

```ts
import { and, eq } from 'drizzle-orm'
import { flock, paddock, type Paddock, type PaddockTheme } from '@metamodels/schema'
import type { Db } from './db'
import { requireCapability, type Actor } from '../auth/authorize'
import { writeAudit } from './audit'
import { NotFoundError } from './flocks-service'
import { savePaddockInput } from '../lib/paddock-schema'

export class SlugTakenError extends Error {
  constructor(slug: string) {
    super(`slug already in use: ${slug}`)
    this.name = 'SlugTakenError'
  }
}

export async function listPaddocks(db: Db, actor: Actor): Promise<Paddock[]> {
  requireCapability(actor, 'read')
  return db.select().from(paddock).where(eq(paddock.orgId, actor.orgId))
}

export async function savePaddock(db: Db, actor: Actor, input: unknown): Promise<Paddock> {
  requireCapability(actor, 'resource.write')
  const data = savePaddockInput.parse(input)

  return db.transaction(async (tx) => {
    // Org-consistency: the flock must exist AND belong to this org.
    const flocks = await tx
      .select({ id: flock.id })
      .from(flock)
      .where(and(eq(flock.id, data.flockId), eq(flock.orgId, actor.orgId)))
      .limit(1)
    if (!flocks[0]) throw new NotFoundError(`flock ${data.flockId}`)

    // Slug is globally unique; reject a collision with a friendly error (the
    // unique index is the race-safe backstop; this gives a clean message).
    const clash = await tx.select({ id: paddock.id }).from(paddock).where(eq(paddock.slug, data.slug)).limit(1)
    if (clash[0] && clash[0].id !== data.id) throw new SlugTakenError(data.slug)

    const values = {
      flockId: data.flockId,
      name: data.name,
      slug: data.slug,
      status: data.status,
      theme: data.theme as PaddockTheme,
    }

    if (data.id) {
      const id = data.id
      const [updated] = await tx
        .update(paddock)
        .set(values)
        .where(and(eq(paddock.id, id), eq(paddock.orgId, actor.orgId)))
        .returning()
      if (!updated) throw new NotFoundError(`paddock ${id}`)
      await writeAudit(tx, {
        orgId: actor.orgId, actor: actor.email, action: 'paddock.update',
        target: `paddock:${updated.id}`, detail: { slug: updated.slug },
      })
      return updated
    }

    const [created] = await tx.insert(paddock).values({ orgId: actor.orgId, ...values }).returning()
    await writeAudit(tx, {
      orgId: actor.orgId, actor: actor.email, action: 'paddock.create',
      target: `paddock:${created.id}`, detail: { slug: created.slug, flockId: created.flockId },
    })
    return created
  })
}

export async function setPaddockStatus(
  db: Db, actor: Actor, id: string, status: 'active' | 'disabled',
): Promise<Paddock> {
  requireCapability(actor, 'resource.write')
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(paddock)
      .set({ status })
      .where(and(eq(paddock.id, id), eq(paddock.orgId, actor.orgId)))
      .returning()
    if (!updated) throw new NotFoundError(`paddock ${id}`)
    await writeAudit(tx, {
      orgId: actor.orgId, actor: actor.email, action: 'paddock.status',
      target: `paddock:${id}`, detail: { status },
    })
    return updated
  })
}

export async function deletePaddock(db: Db, actor: Actor, id: string): Promise<void> {
  requireCapability(actor, 'resource.write')
  await db.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(paddock)
      .where(and(eq(paddock.id, id), eq(paddock.orgId, actor.orgId)))
      .returning()
    if (!deleted) throw new NotFoundError(`paddock ${id}`)
    await writeAudit(tx, {
      orgId: actor.orgId, actor: actor.email, action: 'paddock.delete', target: `paddock:${id}`,
    })
  })
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/paddocks-service.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane/src/lib/paddock-schema.ts apps/control-plane/src/server/paddocks-service.ts apps/control-plane/src/server/paddocks-service.test.ts
git commit -m "feat(control-plane): paddocks service — org-consistent CRUD + slug uniqueness + status toggle"
```

---

## Task 3: Fence config schemas + breed constraint validation

**Files:**
- Create: `apps/control-plane/src/lib/fence-schema.ts`
- Create: `apps/control-plane/src/server/fence-validation.ts`
- Test: `apps/control-plane/src/server/fence-validation.test.ts`

**Interfaces:**
- Produces:
  - `rateLimitSchema` → `{ windowSec: number(int,>0); max: number(int,>=0) }`
  - `quotaRuleSchema` → `{ dim: MeterDim; max: number(int,>=0); period: 'hour'|'day'|'month' }`; `quotaSchema` = `z.array(quotaRuleSchema)`
  - `saveFenceInput` → `{ paddockId: string; constraintJson: unknown; rateLimit?: RateLimit|null; quota?: QuotaRule[]|null }`
  - `validateConstraintForBreed(registry: BreedRegistry, breedId: string, constraintJson: unknown): unknown` — returns the parsed constraint (with breed defaults applied) or throws (`ZodError` on bad constraint; the registry's `Unknown breed` error on a bad breed).
- Consumes: `METER_DIMS`, `BreedRegistry` + breeds from `@metamodels/connectors`, `buildBreedRegistry` (from `./flock-health`, Plan 5.1).
- Note: `constraint_json` is validated per-breed here; `saveFenceInput.constraintJson` stays `z.unknown()` because its real schema depends on the paddock's breed (resolved in Task 4/5).

- [ ] **Step 1: Write the failing test**

`apps/control-plane/src/server/fence-validation.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { buildBreedRegistry } from './flock-health'
import { validateConstraintForBreed } from './fence-validation'

const registry = buildBreedRegistry()

describe('validateConstraintForBreed', () => {
  test('accepts a valid ollama constraint and applies defaults', () => {
    const out = validateConstraintForBreed(registry, 'ollama', { allowedRoutes: ['chat', 'read'] }) as {
      allowedRoutes: string[]; allowedModels: string[] | null
    }
    expect(out.allowedRoutes).toEqual(['chat', 'read'])
    expect(out.allowedModels).toBeNull() // default applied
  })

  test('rejects an ollama constraint that names a mutate route (mutate is not exposable)', () => {
    expect(() => validateConstraintForBreed(registry, 'ollama', { allowedRoutes: ['pull'] })).toThrow()
    expect(() => validateConstraintForBreed(registry, 'ollama', { allowedRoutes: [] })).toThrow() // min(1)
  })

  test('accepts a valid comfyui constraint (templates array, defaults to empty)', () => {
    const out = validateConstraintForBreed(registry, 'comfyui', {}) as { templates: unknown[] }
    expect(out.templates).toEqual([])
  })

  test('rejects an unknown breed', () => {
    expect(() => validateConstraintForBreed(registry, 'bogus', {})).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/fence-validation.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`apps/control-plane/src/lib/fence-schema.ts`:

```ts
import { z } from 'zod'
import { METER_DIMS } from '@metamodels/schema'

// Shape matches the data-plane's RateLimit ({windowSec,max}) and quotaSchema.
export const rateLimitSchema = z.object({
  windowSec: z.number().int().positive(),
  max: z.number().int().nonnegative(),
})
export type RateLimitInput = z.infer<typeof rateLimitSchema>

export const quotaRuleSchema = z.object({
  dim: z.enum(METER_DIMS),
  max: z.number().int().nonnegative(),
  period: z.enum(['hour', 'day', 'month']),
})
export const quotaSchema = z.array(quotaRuleSchema)
export type QuotaRuleInput = z.infer<typeof quotaRuleSchema>

export const saveFenceInput = z.object({
  paddockId: z.string().uuid(),
  constraintJson: z.unknown(), // validated per-breed by validateConstraintForBreed
  rateLimit: rateLimitSchema.nullish(),
  quota: quotaSchema.nullish(),
})
export type SaveFenceInput = z.infer<typeof saveFenceInput>
```

`apps/control-plane/src/server/fence-validation.ts`:

```ts
import type { BreedRegistry } from '@metamodels/connectors'

/**
 * Validate a fence's constraint_json against the paddock's breed. Returns the
 * parsed constraint (breed defaults applied). Throws the registry's error for
 * an unknown breed, or a ZodError for an invalid constraint. This is where
 * `mutate` exposure is structurally impossible: the Ollama constraint enum has
 * no `mutate` member.
 */
export function validateConstraintForBreed(
  registry: BreedRegistry,
  breedId: string,
  constraintJson: unknown,
): unknown {
  const breed = registry.get(breedId)
  return breed.constraintSchema.parse(constraintJson)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/fence-validation.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/lib/fence-schema.ts apps/control-plane/src/server/fence-validation.ts apps/control-plane/src/server/fence-validation.test.ts
git commit -m "feat(control-plane): fence config schemas + breed-aware constraint validation"
```

---

## Task 4: Fences service (get / save with validation-on-write)

**Files:**
- Create: `apps/control-plane/src/server/fences-service.ts`
- Test: `apps/control-plane/src/server/fences-service.test.ts`

**Interfaces:**
- Produces:
  - `getFence(db, actor, paddockId): Promise<Fence | null>` (`read`; paddock must be in org else `NotFoundError`; returns the paddock's fence row or `null`)
  - `saveFence(db, actor, registry, input): Promise<Fence>` (`resource.write`; loads the paddock+flock scoped to org to get the breed; validates `constraint_json` via `validateConstraintForBreed`; validates `rateLimit`/`quota` via `saveFenceInput`; one-fence-per-paddock upsert via `onConflictDoUpdate(target: fence.paddockId)`; audits `fence.save`)
- Consumes: `NotFoundError` (from `./flocks-service`), `requireCapability`/`Actor`, `writeAudit`, `saveFenceInput` (Task 3), `validateConstraintForBreed` (Task 3), `fence`/`paddock`/`flock`/`Fence`, `BreedRegistry`.

- [ ] **Step 1: Write the failing test**

`apps/control-plane/src/server/fences-service.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '@metamodels/schema'
import { freshDb, seedOrg } from '../test/db'
import { getFence, saveFence } from './fences-service'
import { NotFoundError } from './flocks-service'
import { ForbiddenError, type Actor } from '../auth/authorize'
import { buildBreedRegistry } from './flock-health'

const registry = buildBreedRegistry()
type TDb = Awaited<ReturnType<typeof freshDb>>

async function orgFlockPaddock(db: TDb, breed = 'ollama', role: Actor['role'] = 'admin') {
  const o = await seedOrg(db)
  const [f] = await db.insert(schema.flock).values({ orgId: o.id, breed, name: 'f', baseUrl: 'http://x' }).returning()
  const [p] = await db.insert(schema.paddock).values({ orgId: o.id, flockId: f.id, slug: 's', name: 'P' }).returning()
  const actor: Actor = { id: 'u1', orgId: o.id, email: `${role}@x.io`, role }
  return { o, f, p, actor }
}

describe('fences-service', () => {
  test('saves a valid ollama fence (validated + audited), then getFence returns it', async () => {
    const db = await freshDb()
    const { p, actor } = await orgFlockPaddock(db)
    const fence = await saveFence(db, actor, registry, {
      paddockId: p.id,
      constraintJson: { allowedRoutes: ['chat'], allowedModels: ['llama3'] },
      rateLimit: { windowSec: 60, max: 30 },
      quota: [{ dim: 'tokens_out', max: 100000, period: 'day' }],
    })
    expect(fence.paddockId).toBe(p.id)
    expect((fence.constraintJson as { allowedRoutes: string[] }).allowedRoutes).toEqual(['chat'])
    const got = await getFence(db, actor, p.id)
    expect(got?.id).toBe(fence.id)
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'fence.save'))
    expect(audits).toHaveLength(1)
  })

  test('saving twice updates the same fence (one per paddock)', async () => {
    const db = await freshDb()
    const { p, actor } = await orgFlockPaddock(db)
    const a = await saveFence(db, actor, registry, { paddockId: p.id, constraintJson: { allowedRoutes: ['chat'] } })
    const b = await saveFence(db, actor, registry, { paddockId: p.id, constraintJson: { allowedRoutes: ['chat', 'read'] } })
    expect(b.id).toBe(a.id)
    expect(await db.select().from(schema.fence)).toHaveLength(1)
    expect((b.constraintJson as { allowedRoutes: string[] }).allowedRoutes).toEqual(['chat', 'read'])
  })

  test('rejects an invalid constraint before any write', async () => {
    const db = await freshDb()
    const { p, actor } = await orgFlockPaddock(db)
    await expect(saveFence(db, actor, registry, { paddockId: p.id, constraintJson: { allowedRoutes: ['pull'] } }))
      .rejects.toThrow()
    expect(await db.select().from(schema.fence)).toHaveLength(0)
  })

  test('rejects an invalid rate limit before any write', async () => {
    const db = await freshDb()
    const { p, actor } = await orgFlockPaddock(db)
    await expect(saveFence(db, actor, registry, {
      paddockId: p.id, constraintJson: { allowedRoutes: ['chat'] }, rateLimit: { windowSec: 0, max: -5 },
    })).rejects.toThrow()
    expect(await db.select().from(schema.fence)).toHaveLength(0)
  })

  test('viewer cannot save a fence', async () => {
    const db = await freshDb()
    const { p, actor } = await orgFlockPaddock(db, 'ollama', 'viewer')
    await expect(saveFence(db, actor, registry, { paddockId: p.id, constraintJson: { allowedRoutes: ['chat'] } }))
      .rejects.toThrow(ForbiddenError)
  })

  test('cannot save or read a fence on a paddock in another org', async () => {
    const db = await freshDb()
    const { actor } = await orgFlockPaddock(db)
    const [otherOrg] = await db.insert(schema.org).values({ name: 'other' }).returning()
    const [of] = await db.insert(schema.flock).values({ orgId: otherOrg.id, breed: 'ollama', name: 'of', baseUrl: 'http://z' }).returning()
    const [foreign] = await db.insert(schema.paddock).values({ orgId: otherOrg.id, flockId: of.id, slug: 'fp', name: 'F' }).returning()
    await expect(saveFence(db, actor, registry, { paddockId: foreign.id, constraintJson: { allowedRoutes: ['chat'] } }))
      .rejects.toThrow(NotFoundError)
    await expect(getFence(db, actor, foreign.id)).rejects.toThrow(NotFoundError)
    expect(await db.select().from(schema.fence)).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/fences-service.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`apps/control-plane/src/server/fences-service.ts`:

```ts
import { and, eq } from 'drizzle-orm'
import type { BreedRegistry } from '@metamodels/connectors'
import { fence, flock, paddock, type Fence } from '@metamodels/schema'
import type { Db } from './db'
import { requireCapability, type Actor } from '../auth/authorize'
import { writeAudit } from './audit'
import { NotFoundError } from './flocks-service'
import { saveFenceInput } from '../lib/fence-schema'
import { validateConstraintForBreed } from './fence-validation'

/** Load a paddock scoped to the actor's org, returning its breed. Throws NotFoundError otherwise. */
async function paddockBreedInOrg(tx: Db, actor: Actor, paddockId: string): Promise<string> {
  const rows = await tx
    .select({ breed: flock.breed })
    .from(paddock)
    .innerJoin(flock, eq(paddock.flockId, flock.id))
    .where(and(eq(paddock.id, paddockId), eq(paddock.orgId, actor.orgId)))
    .limit(1)
  if (!rows[0]) throw new NotFoundError(`paddock ${paddockId}`)
  return rows[0].breed
}

export async function getFence(db: Db, actor: Actor, paddockId: string): Promise<Fence | null> {
  requireCapability(actor, 'read')
  await paddockBreedInOrg(db, actor, paddockId) // enforces org ownership (throws NotFoundError)
  const rows = await db.select().from(fence).where(eq(fence.paddockId, paddockId)).limit(1)
  return rows[0] ?? null
}

export async function saveFence(
  db: Db, actor: Actor, registry: BreedRegistry, input: unknown,
): Promise<Fence> {
  requireCapability(actor, 'resource.write')
  const data = saveFenceInput.parse(input) // validates rateLimit + quota shapes

  return db.transaction(async (tx) => {
    const breedId = await paddockBreedInOrg(tx, actor, data.paddockId)
    const constraint = validateConstraintForBreed(registry, breedId, data.constraintJson)

    const [saved] = await tx
      .insert(fence)
      .values({
        orgId: actor.orgId,
        paddockId: data.paddockId,
        constraintJson: constraint as never,
        rateLimit: (data.rateLimit ?? null) as never,
        quota: (data.quota ?? null) as never,
      })
      .onConflictDoUpdate({
        target: fence.paddockId,
        set: {
          constraintJson: constraint as never,
          rateLimit: (data.rateLimit ?? null) as never,
          quota: (data.quota ?? null) as never,
        },
      })
      .returning()

    await writeAudit(tx, {
      orgId: actor.orgId, actor: actor.email, action: 'fence.save',
      target: `paddock:${data.paddockId}`, detail: { breed: breedId },
    })
    return saved
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/fences-service.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/server/fences-service.ts apps/control-plane/src/server/fences-service.test.ts
git commit -m "feat(control-plane): fences service — validate-on-write + one-per-paddock upsert (audited)"
```

---

## Task 5: Blast-radius summary

**Files:**
- Create: `apps/control-plane/src/server/blast-radius.ts`
- Test: `apps/control-plane/src/server/blast-radius.test.ts`

**Interfaces:**
- Produces:
  - `interface BlastRadius { breedId: string; mutateLocked: true; exposed: string[]; models: 'any' | string[]; templateCount: number | null; rateLimit: RateLimitInput | null; quota: QuotaRuleInput[] }`
  - `computeBlastRadius(breedId: string, constraintJson: unknown, rateLimit: unknown, quota: unknown): BlastRadius` — pure; interprets an already-persisted fence for the BlastRadiusCard. Best-effort: tolerant of `null`/partial JSON (a fence may have `constraintJson: {}`).
- Consumes: `RateLimitInput`/`QuotaRuleInput` types from `../lib/fence-schema`.
- Note: this reads a fence row's raw JSON columns (already validated on write), so it parses defensively rather than throwing.

- [ ] **Step 1: Write the failing test**

`apps/control-plane/src/server/blast-radius.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { computeBlastRadius } from './blast-radius'

describe('computeBlastRadius', () => {
  test('ollama: exposes allowed routes + model allowlist, mutate always locked', () => {
    const br = computeBlastRadius(
      'ollama',
      { allowedRoutes: ['chat', 'read'], allowedModels: ['llama3'] },
      { windowSec: 60, max: 30 },
      [{ dim: 'tokens_out', max: 100000, period: 'day' }],
    )
    expect(br.breedId).toBe('ollama')
    expect(br.mutateLocked).toBe(true)
    expect(br.exposed).toEqual(['chat', 'read'])
    expect(br.models).toEqual(['llama3'])
    expect(br.templateCount).toBeNull()
    expect(br.rateLimit).toEqual({ windowSec: 60, max: 30 })
    expect(br.quota).toHaveLength(1)
  })

  test('ollama: null allowedModels means any model', () => {
    const br = computeBlastRadius('ollama', { allowedRoutes: ['chat'], allowedModels: null }, null, null)
    expect(br.models).toBe('any')
    expect(br.rateLimit).toBeNull()
    expect(br.quota).toEqual([])
  })

  test('comfyui: exposes template ids and a count', () => {
    const br = computeBlastRadius(
      'comfyui',
      { templates: [{ id: 'txt2img', graph: {}, params: [], cost: 1 }, { id: 'img2img', graph: {}, params: [], cost: 2 }] },
      null, null,
    )
    expect(br.exposed).toEqual(['txt2img', 'img2img'])
    expect(br.templateCount).toBe(2)
    expect(br.models).toBe('any')
  })

  test('tolerates empty / malformed constraint JSON without throwing', () => {
    const br = computeBlastRadius('ollama', {}, undefined, undefined)
    expect(br.exposed).toEqual([])
    expect(br.models).toBe('any')
    expect(br.mutateLocked).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/blast-radius.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`apps/control-plane/src/server/blast-radius.ts`:

```ts
import type { QuotaRuleInput, RateLimitInput } from '../lib/fence-schema'

export interface BlastRadius {
  breedId: string
  mutateLocked: true
  exposed: string[]
  models: 'any' | string[]
  templateCount: number | null
  rateLimit: RateLimitInput | null
  quota: QuotaRuleInput[]
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

export function computeBlastRadius(
  breedId: string,
  constraintJson: unknown,
  rateLimit: unknown,
  quota: unknown,
): BlastRadius {
  const c = asRecord(constraintJson)
  const rl = asRecord(rateLimit)
  const hasRate = typeof rl.windowSec === 'number' && typeof rl.max === 'number'

  let exposed: string[] = []
  let models: 'any' | string[] = 'any'
  let templateCount: number | null = null

  if (breedId === 'comfyui') {
    const templates = Array.isArray(c.templates) ? c.templates : []
    exposed = templates.map((t) => String(asRecord(t).id ?? '')).filter(Boolean)
    templateCount = templates.length
  } else {
    exposed = Array.isArray(c.allowedRoutes) ? c.allowedRoutes.map(String) : []
    models = Array.isArray(c.allowedModels) ? c.allowedModels.map(String) : 'any'
  }

  return {
    breedId,
    mutateLocked: true,
    exposed,
    models,
    templateCount,
    rateLimit: hasRate ? { windowSec: rl.windowSec as number, max: rl.max as number } : null,
    quota: Array.isArray(quota) ? (quota as QuotaRuleInput[]) : [],
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @metamodels/control-plane exec vitest run src/server/blast-radius.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/server/blast-radius.ts apps/control-plane/src/server/blast-radius.test.ts
git commit -m "feat(control-plane): blast-radius summary derive for the fence card"
```

---

## Task 6: Paddocks screen (9b) — cards + new-paddock panel + status toggle

**Files:**
- Create: `apps/control-plane/src/app/(app)/paddocks/actions.ts`
- Create: `apps/control-plane/src/app/(app)/paddocks/page.tsx`
- Create: `apps/control-plane/src/app/(app)/paddocks/paddocks-client.tsx`

**Interfaces:**
- Consumes: `listPaddocks`/`savePaddock`/`deletePaddock`/`setPaddockStatus`/`SlugTakenError` (Task 2), `listFlocks` (Plan 5.1), `requireUser` (guard), `authorize`/`requireCapability`, UI primitives + `BreedChip`/`StatusPill`.
- Produces: screen 9b — a table/cards list of paddocks (name, slug as `/p/:slug`, flock/breed, status Switch, disabled dimmed, Fence link, Delete), and a "New paddock" Drawer (flock Select, name, slug with live `/p/:slug` preview, theme Select) with server-action save.
- Thin glue; gated by `tsc --noEmit` + `next build`. No new unit test (services covered in Task 2).

- [ ] **Step 1: Implement the server actions**

`apps/control-plane/src/app/(app)/paddocks/actions.ts`:

```ts
'use server'
import { revalidatePath } from 'next/cache'
import { getDb } from '../../../server/db'
import { requireUser } from '../../../server/guard'
import { requireCapability } from '../../../auth/authorize'
import { savePaddock, deletePaddock, setPaddockStatus, SlugTakenError } from '../../../server/paddocks-service'
import { NotFoundError } from '../../../server/flocks-service'

export async function savePaddockAction(_prev: unknown, fd: FormData): Promise<{ error?: string; ok?: boolean }> {
  const actor = await requireUser()
  try {
    requireCapability(actor, 'resource.write')
    await savePaddock(getDb(), actor, {
      id: (String(fd.get('id') ?? '') || undefined),
      flockId: String(fd.get('flockId') ?? ''),
      name: String(fd.get('name') ?? '').trim(),
      slug: String(fd.get('slug') ?? '').trim(),
      status: (String(fd.get('status') ?? 'active') as 'active' | 'disabled'),
      theme: (String(fd.get('theme') ?? 'plain') as 'plain' | 'metaboy'),
    })
    revalidatePath('/paddocks')
    return { ok: true }
  } catch (e) {
    if (e instanceof SlugTakenError) return { error: e.message }
    if (e instanceof NotFoundError) return { error: 'Selected flock not found in your org.' }
    return { error: e instanceof Error ? e.message : 'Failed to save paddock' }
  }
}

export async function togglePaddockStatusAction(fd: FormData): Promise<void> {
  const actor = await requireUser()
  requireCapability(actor, 'resource.write')
  const next = String(fd.get('status')) === 'active' ? 'disabled' : 'active'
  await setPaddockStatus(getDb(), actor, String(fd.get('id')), next)
  revalidatePath('/paddocks')
}

export async function deletePaddockAction(fd: FormData): Promise<void> {
  const actor = await requireUser()
  requireCapability(actor, 'resource.write')
  await deletePaddock(getDb(), actor, String(fd.get('id')))
  revalidatePath('/paddocks')
}
```

- [ ] **Step 2: Implement the page (server component)**

`apps/control-plane/src/app/(app)/paddocks/page.tsx`:

```tsx
import { getDb } from '../../../server/db'
import { requireUser } from '../../../server/guard'
import { authorize } from '../../../auth/authorize'
import { listPaddocks } from '../../../server/paddocks-service'
import { listFlocks } from '../../../server/flocks-service'
import { PaddocksClient } from './paddocks-client'

export default async function PaddocksPage() {
  const actor = await requireUser()
  const db = getDb()
  const [paddocks, flocks] = await Promise.all([listPaddocks(db, actor), listFlocks(db, actor)])
  const byFlock = new Map(flocks.map((f) => [f.id, f]))
  return (
    <PaddocksClient
      canWrite={authorize(actor, 'resource.write')}
      flocks={flocks.map((f) => ({ id: f.id, name: f.name, breed: f.breed }))}
      paddocks={paddocks.map((p) => ({
        id: p.id, name: p.name, slug: p.slug, status: p.status, theme: p.theme,
        flockName: byFlock.get(p.flockId)?.name ?? '—', breed: byFlock.get(p.flockId)?.breed ?? '—',
      }))}
    />
  )
}
```

- [ ] **Step 3: Implement the client island**

`apps/control-plane/src/app/(app)/paddocks/paddocks-client.tsx`:

```tsx
'use client'
import { useState } from 'react'
import Link from 'next/link'
import { PageHeader } from '../../../components/page-header'
import { DataTable } from '../../../components/ui/data-table'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { Label } from '../../../components/ui/label'
import { Select } from '../../../components/ui/select'
import { Drawer } from '../../../components/ui/drawer'
import { StatusPill } from '../../../components/ui/status-pill'
import { BreedChip } from '../../../components/ui/breed-chip'
import { cn } from '../../../components/ui/cn'
import { savePaddockAction, deletePaddockAction, togglePaddockStatusAction } from './actions'

interface FlockOpt { id: string; name: string; breed: string }
interface Row { id: string; name: string; slug: string; status: string; theme: string; flockName: string; breed: string }

export function PaddocksClient({ paddocks, flocks, canWrite }: { paddocks: Row[]; flocks: FlockOpt[]; canWrite: boolean }) {
  const [open, setOpen] = useState(false)
  const [slug, setSlug] = useState('')
  const [error, setError] = useState<string | undefined>()

  async function onSave(fd: FormData) {
    const r = await savePaddockAction(null, fd)
    if (r.error) setError(r.error)
    else { setOpen(false); setError(undefined); setSlug('') }
  }

  return (
    <div>
      <PageHeader
        title="Paddocks"
        subtitle="Published, fenced endpoints on your Flocks."
        actions={canWrite && flocks.length > 0 && <Button onClick={() => setOpen(true)}>New paddock</Button>}
      />
      {flocks.length === 0 && (
        <p className="mb-4 text-sm text-[var(--color-muted)]">Connect a Flock first, then publish a Paddock on it.</p>
      )}
      <DataTable headers={['Name', 'Public URL', 'Flock', 'Status', '']}>
        {paddocks.map((p) => (
          <tr key={p.id} className={cn('border-b border-[var(--color-divider)]', p.status !== 'active' && 'opacity-50')}>
            <td className="px-3 py-2 text-[var(--color-text)]">{p.name}</td>
            <td className="px-3 py-2 font-mono text-xs text-[var(--color-muted)]">/p/{p.slug}</td>
            <td className="px-3 py-2"><BreedChip breed={p.breed} /> <span className="text-[var(--color-muted)]">{p.flockName}</span></td>
            <td className="px-3 py-2"><StatusPill ok={p.status === 'active'} labels={['Active', 'Disabled']} /></td>
            <td className="px-3 py-2 text-right">
              <Link href={`/paddocks/${p.id}/fence`} className="mr-3 text-sm text-[var(--color-primary)] hover:underline">Fence</Link>
              {canWrite && (
                <>
                  <form action={togglePaddockStatusAction} className="inline">
                    <input type="hidden" name="id" value={p.id} />
                    <input type="hidden" name="status" value={p.status} />
                    <Button variant="ghost" type="submit">{p.status === 'active' ? 'Disable' : 'Enable'}</Button>
                  </form>
                  <form action={deletePaddockAction} className="ml-2 inline">
                    <input type="hidden" name="id" value={p.id} />
                    <Button variant="danger" type="submit">Delete</Button>
                  </form>
                </>
              )}
            </td>
          </tr>
        ))}
        {paddocks.length === 0 && (
          <tr><td colSpan={5} className="px-3 py-8 text-center text-[var(--color-muted)]">No paddocks yet.</td></tr>
        )}
      </DataTable>

      <Drawer open={open} onClose={() => setOpen(false)} title="New paddock">
        <form action={onSave} className="flex flex-col gap-4">
          <div>
            <Label htmlFor="flockId">Flock</Label>
            <Select id="flockId" name="flockId" required>
              {flocks.map((f) => <option key={f.id} value={f.id}>{f.name} ({f.breed})</option>)}
            </Select>
          </div>
          <div><Label htmlFor="name">Name</Label><Input id="name" name="name" required /></div>
          <div>
            <Label htmlFor="slug">Slug</Label>
            <Input id="slug" name="slug" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="small-models" required />
            <p className="mt-1 font-mono text-xs text-[var(--color-faint)]">Public URL: /p/{slug || '<slug>'}</p>
          </div>
          <div>
            <Label htmlFor="theme">Consumer theme</Label>
            <Select id="theme" name="theme" defaultValue="plain">
              <option value="plain">Plain</option>
              <option value="metaboy">MetaBoy</option>
            </Select>
          </div>
          <input type="hidden" name="status" value="active" />
          {error && <div className="text-sm text-[var(--color-danger)]">{error}</div>}
          <Button type="submit">Publish paddock</Button>
        </form>
      </Drawer>
    </div>
  )
}
```

- [ ] **Step 4: Verify build + typecheck**

Run: `pnpm --filter @metamodels/control-plane exec tsc --noEmit && pnpm --filter @metamodels/control-plane build`
Expected: no type errors; `/paddocks` route compiles.

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane/src/app/\(app\)/paddocks
git commit -m "feat(control-plane): Paddocks screen (9b) — cards, new-paddock drawer w/ live URL, status toggle"
```

---

## Task 7: Fence editor screen (9c) — routes (mutate locked) + models + rate/quota + Blast Radius

**Files:**
- Create: `apps/control-plane/src/components/ui/blast-radius-card.tsx`
- Create: `apps/control-plane/src/app/(app)/paddocks/[id]/fence/actions.ts`
- Create: `apps/control-plane/src/app/(app)/paddocks/[id]/fence/page.tsx`
- Create: `apps/control-plane/src/app/(app)/paddocks/[id]/fence/fence-client.tsx`

**Interfaces:**
- Consumes: `getFence`/`saveFence` (Task 4), `computeBlastRadius` (Task 5), `listPaddocks` + `listFlocks` (to resolve the paddock's breed/slug for the header), `buildBreedRegistry` (Plan 5.1), `requireUser`/`authorize`/`requireCapability`, UI primitives.
- Produces: screen 9c — for an **Ollama** paddock: route-class rows (`chat`/`generate`/`embed`/`read` toggles; a permanently-locked `mutate` row) + model allowlist (comma-separated) + rate limit + quota rows + a `BlastRadiusCard`. For a **ComfyUI** paddock: a "templates are managed in the Template editor (Plan 5.3)" note + rate limit + quota + BlastRadiusCard.
- Thin glue; gated by `tsc --noEmit` + `next build`. No new unit test (logic covered in Tasks 4–5).

- [ ] **Step 1: Implement the BlastRadiusCard**

`apps/control-plane/src/components/ui/blast-radius-card.tsx`:

```tsx
import type { BlastRadius } from '../../server/blast-radius'

export function BlastRadiusCard({ br }: { br: BlastRadius }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-panel)] p-4">
      <h3 className="mb-3 text-sm font-semibold text-[var(--color-text)]">Blast radius</h3>
      <dl className="space-y-2 text-sm">
        <div className="flex justify-between"><dt className="text-[var(--color-muted)]">Breed</dt><dd className="font-mono">{br.breedId}</dd></div>
        <div className="flex justify-between">
          <dt className="text-[var(--color-muted)]">{br.breedId === 'comfyui' ? 'Templates' : 'Routes'}</dt>
          <dd className="font-mono text-right">{br.exposed.length ? br.exposed.join(', ') : '—'}{br.templateCount !== null ? ` (${br.templateCount})` : ''}</dd>
        </div>
        {br.breedId !== 'comfyui' && (
          <div className="flex justify-between"><dt className="text-[var(--color-muted)]">Models</dt><dd className="font-mono text-right">{br.models === 'any' ? 'any' : br.models.join(', ')}</dd></div>
        )}
        <div className="flex justify-between"><dt className="text-[var(--color-muted)]">Rate limit</dt><dd className="font-mono">{br.rateLimit ? `${br.rateLimit.max}/${br.rateLimit.windowSec}s` : 'none'}</dd></div>
        <div className="flex justify-between"><dt className="text-[var(--color-muted)]">Quotas</dt><dd className="font-mono text-right">{br.quota.length ? br.quota.map((q) => `${q.max} ${q.dim}/${q.period}`).join('; ') : 'none'}</dd></div>
        <div className="flex justify-between"><dt className="text-[var(--color-muted)]">Model management</dt><dd className="font-mono text-[var(--color-comfyui)]">🔒 locked</dd></div>
      </dl>
    </div>
  )
}
```

- [ ] **Step 2: Implement the server actions**

`apps/control-plane/src/app/(app)/paddocks/[id]/fence/actions.ts`:

```ts
'use server'
import { revalidatePath } from 'next/cache'
import { getDb } from '../../../../../server/db'
import { requireUser } from '../../../../../server/guard'
import { requireCapability } from '../../../../../auth/authorize'
import { saveFence } from '../../../../../server/fences-service'
import { buildBreedRegistry } from '../../../../../server/flock-health'

const registry = buildBreedRegistry()

export async function saveFenceAction(_prev: unknown, fd: FormData): Promise<{ error?: string; ok?: boolean }> {
  const actor = await requireUser()
  const paddockId = String(fd.get('paddockId') ?? '')
  const breed = String(fd.get('breed') ?? '')
  try {
    requireCapability(actor, 'resource.write')

    // Build constraint_json per breed from the form.
    let constraintJson: unknown
    if (breed === 'comfyui') {
      // Templates are authored in the paramSchema editor (Plan 5.3); preserve whatever exists.
      constraintJson = JSON.parse(String(fd.get('constraintJson') ?? '{"templates":[]}'))
    } else {
      const routes = fd.getAll('route').map(String)
      const modelsRaw = String(fd.get('models') ?? '').trim()
      const allowedModels = modelsRaw ? modelsRaw.split(',').map((m) => m.trim()).filter(Boolean) : null
      constraintJson = { allowedRoutes: routes, allowedModels }
    }

    const rlMax = Number(fd.get('rlMax'))
    const rlWindow = Number(fd.get('rlWindow'))
    const rateLimit = rlMax > 0 && rlWindow > 0 ? { windowSec: rlWindow, max: rlMax } : null

    const qDim = String(fd.get('qDim') ?? '')
    const qMax = Number(fd.get('qMax'))
    const qPeriod = String(fd.get('qPeriod') ?? '')
    const quota = qDim && qMax > 0 && qPeriod ? [{ dim: qDim, max: qMax, period: qPeriod }] : null

    await saveFence(getDb(), actor, registry, { paddockId, constraintJson, rateLimit, quota })
    revalidatePath(`/paddocks/${paddockId}/fence`)
    return { ok: true }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed to save fence' }
  }
}
```

- [ ] **Step 3: Implement the page (server component)**

`apps/control-plane/src/app/(app)/paddocks/[id]/fence/page.tsx`:

```tsx
import { notFound } from 'next/navigation'
import { getDb } from '../../../../../server/db'
import { requireUser } from '../../../../../server/guard'
import { authorize } from '../../../../../auth/authorize'
import { listPaddocks } from '../../../../../server/paddocks-service'
import { listFlocks } from '../../../../../server/flocks-service'
import { getFence } from '../../../../../server/fences-service'
import { computeBlastRadius } from '../../../../../server/blast-radius'
import { FenceClient } from './fence-client'

export default async function FencePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const actor = await requireUser()
  const db = getDb()
  const paddocks = await listPaddocks(db, actor)
  const paddock = paddocks.find((p) => p.id === id)
  if (!paddock) notFound()
  const flocks = await listFlocks(db, actor)
  const breed = flocks.find((f) => f.id === paddock.flockId)?.breed ?? 'ollama'
  const fence = await getFence(db, actor, id)
  const br = computeBlastRadius(breed, fence?.constraintJson ?? {}, fence?.rateLimit ?? null, fence?.quota ?? null)

  return (
    <FenceClient
      canWrite={authorize(actor, 'resource.write')}
      paddock={{ id: paddock.id, name: paddock.name, slug: paddock.slug, breed }}
      constraintJson={(fence?.constraintJson ?? null) as unknown}
      rateLimit={(fence?.rateLimit ?? null) as { windowSec: number; max: number } | null}
      quota={(fence?.quota ?? null) as Array<{ dim: string; max: number; period: string }> | null}
      blastRadius={br}
    />
  )
}
```

- [ ] **Step 4: Implement the client island**

`apps/control-plane/src/app/(app)/paddocks/[id]/fence/fence-client.tsx`:

```tsx
'use client'
import { useState } from 'react'
import Link from 'next/link'
import { PageHeader } from '../../../../../components/page-header'
import { Button } from '../../../../../components/ui/button'
import { Input } from '../../../../../components/ui/input'
import { Label } from '../../../../../components/ui/label'
import { Select } from '../../../../../components/ui/select'
import { cn } from '../../../../../components/ui/cn'
import { BlastRadiusCard } from '../../../../../components/ui/blast-radius-card'
import type { BlastRadius } from '../../../../../server/blast-radius'
import { saveFenceAction } from './actions'

const OLLAMA_ROUTES = ['chat', 'generate', 'embed', 'read'] as const
const METER_DIMS = ['tokens_in', 'tokens_out', 'jobs', 'gpu_ms', 'images'] as const

interface Paddock { id: string; name: string; slug: string; breed: string }

export function FenceClient({
  paddock, constraintJson, rateLimit, quota, blastRadius, canWrite,
}: {
  paddock: Paddock
  constraintJson: unknown
  rateLimit: { windowSec: number; max: number } | null
  quota: Array<{ dim: string; max: number; period: string }> | null
  blastRadius: BlastRadius
  canWrite: boolean
}) {
  const c = (constraintJson ?? {}) as { allowedRoutes?: string[]; allowedModels?: string[] | null }
  const q0 = quota?.[0]
  const [error, setError] = useState<string | undefined>()
  const [saved, setSaved] = useState(false)

  async function onSave(fd: FormData) {
    setError(undefined); setSaved(false)
    const r = await saveFenceAction(null, fd)
    if (r.error) setError(r.error)
    else setSaved(true)
  }

  return (
    <div>
      <PageHeader
        title={`Fence — ${paddock.name}`}
        subtitle={`Policy for /p/${paddock.slug}`}
        actions={<Link href="/paddocks" className="text-sm text-[var(--color-muted)] hover:underline">← Paddocks</Link>}
      />
      <div className="grid grid-cols-[1fr_320px] gap-6">
        <form action={onSave} className="flex flex-col gap-6">
          <input type="hidden" name="paddockId" value={paddock.id} />
          <input type="hidden" name="breed" value={paddock.breed} />

          {paddock.breed === 'comfyui' ? (
            <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-4 text-sm text-[var(--color-muted)]">
              Workflow templates for this ComfyUI paddock are authored in the Template editor (coming in Plan 5.3). Rate limit and quota still apply below.
              <input type="hidden" name="constraintJson" value={JSON.stringify(constraintJson ?? { templates: [] })} />
            </div>
          ) : (
            <fieldset className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-4">
              <legend className="px-1 text-sm font-semibold">Route classes</legend>
              {OLLAMA_ROUTES.map((r) => (
                <label key={r} className="flex items-center gap-2 py-1 text-sm">
                  <input type="checkbox" name="route" value={r} defaultChecked={c.allowedRoutes?.includes(r)} />
                  <span className="font-mono">{r}</span>
                </label>
              ))}
              <div className="mt-2 flex items-center gap-2 py-1 text-sm text-[var(--color-comfyui)]">
                <input type="checkbox" disabled />
                <span className="font-mono">mutate</span>
                <span className="ml-auto">🔒 permanently locked — model management is never exposable</span>
              </div>
              <div className="mt-4">
                <Label htmlFor="models">Model allowlist (comma-separated; blank = any)</Label>
                <Input id="models" name="models" defaultValue={(c.allowedModels ?? []).join(', ')} placeholder="llama3, mistral" />
              </div>
            </fieldset>
          )}

          <fieldset className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-4">
            <legend className="px-1 text-sm font-semibold">Rate limit</legend>
            <div className="flex items-end gap-3">
              <div><Label htmlFor="rlMax">Max requests</Label><Input id="rlMax" name="rlMax" type="number" min={0} defaultValue={rateLimit?.max ?? ''} /></div>
              <div><Label htmlFor="rlWindow">Per window (sec)</Label><Input id="rlWindow" name="rlWindow" type="number" min={0} defaultValue={rateLimit?.windowSec ?? ''} /></div>
            </div>
          </fieldset>

          <fieldset className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-4">
            <legend className="px-1 text-sm font-semibold">Quota (one dimension)</legend>
            <div className="flex items-end gap-3">
              <div>
                <Label htmlFor="qDim">Dimension</Label>
                <Select id="qDim" name="qDim" defaultValue={q0?.dim ?? ''}>
                  <option value="">none</option>
                  {METER_DIMS.map((d) => <option key={d} value={d}>{d}</option>)}
                </Select>
              </div>
              <div><Label htmlFor="qMax">Max</Label><Input id="qMax" name="qMax" type="number" min={0} defaultValue={q0?.max ?? ''} /></div>
              <div>
                <Label htmlFor="qPeriod">Period</Label>
                <Select id="qPeriod" name="qPeriod" defaultValue={q0?.period ?? ''}>
                  <option value="">—</option>
                  <option value="hour">hour</option>
                  <option value="day">day</option>
                  <option value="month">month</option>
                </Select>
              </div>
            </div>
          </fieldset>

          {error && <div className="text-sm text-[var(--color-danger)]">{error}</div>}
          {saved && <div className="text-sm text-[var(--color-primary)]">Fence saved.</div>}
          {canWrite && <div><Button type="submit">Save fence</Button></div>}
        </form>

        <div className={cn(!canWrite && 'opacity-90')}>
          <BlastRadiusCard br={blastRadius} />
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Verify build + typecheck**

Run: `pnpm --filter @metamodels/control-plane exec tsc --noEmit && pnpm --filter @metamodels/control-plane build`
Expected: no type errors; `/paddocks/[id]/fence` compiles.

- [ ] **Step 6: Commit**

```bash
git add apps/control-plane/src/components/ui/blast-radius-card.tsx apps/control-plane/src/app/\(app\)/paddocks
git commit -m "feat(control-plane): Fence editor (9c) — routes (mutate locked) + models + rate/quota + blast radius"
```

---

## Task 8: Whole-app verification

**Files:**
- Modify (only if needed): `apps/control-plane/README.md`

**Interfaces:**
- Produces: green whole-repo across both test lanes + typecheck, with the new Paddocks/Fence routes compiling.

- [ ] **Step 1: Run both test lanes + typecheck**

Run:
```bash
pnpm exec vitest run packages/schema/test/schema.test.ts
pnpm --filter @metamodels/control-plane exec vitest run
pnpm typecheck
```
Expected: schema suite green (incl. the 2 new Task-1 cases); control-plane suite green (adds paddocks-service, fence-validation, fences-service, blast-radius — ~23 new tests over the 32 from Plan 5.1); `tsc -b` clean.

- [ ] **Step 2: Run the root suite**

Run: `pnpm test`
Expected: 166 pass / 3 skip (Plan 5.1's 164 + the 2 new schema cases from Task 1).

- [ ] **Step 3: Build**

Run: `pnpm --filter @metamodels/control-plane build`
Expected: `/paddocks` and `/paddocks/[id]/fence` compile alongside the existing routes.

- [ ] **Step 4: (Optional) README note**

If the README's screen list is worth updating, add Paddocks + Fence editor to `apps/control-plane/README.md`. Otherwise skip.

- [ ] **Step 5: Commit (if anything changed)**

```bash
git add -A
git commit -m "test(control-plane): confirm Plan 5.2 whole-repo green (paddocks + fences)"
```

If nothing changed in this task, skip the commit.

---

## Self-Review

**Spec / roadmap coverage (against the Plan 5.2 row + the roadmap "Carry-forward from Plan 5.1"):**

| Requirement | Task |
|---|---|
| Publish a fenced Paddock (create on org flock) | 2 |
| Live `/p/:slug` (slug validated + shown) | 2 (slug), 6 (preview) |
| Status toggle (active↔disabled, disabled dimmed) | 2 (setPaddockStatus), 6 (UI) |
| `paddock.theme` (plain↔MetaBoy) for the consumer track | 1 (schema), 2 (save), 6 (UI) |
| Breed-aware Fence, `mutate` hard-locked | 3 (validation), 4 (service), 7 (locked UI) |
| Model allowlist | 3/4 (constraint), 7 (UI) |
| Rate limit + quota | 3 (schemas), 4 (persist), 7 (UI) |
| Blast Radius | 5 (compute), 7 (card) |
| Fence `constraint_json` + `quota` **validation on write** | 3, 4 |
| Copy the 5.1 tx CRUD template (mutation+audit atomic) | 2, 4 (all mutations wrapped) |
| key↔paddock **org-consistency groundwork** (paddock→flock in-org) | 2 |
| Screens 9b, 9c | 6, 7 |

**Deferred correctly:** ComfyUI fence **templates** are authored in the ★ paramSchema editor (Plan 5.3) — 5.2's Fence editor targets Ollama routes/models and leaves a note for ComfyUI; the `fences-service` still validates ComfyUI constraints generically. The key↔paddock link itself is Plan 5.4. Dashboard/Usage/Audit are 5.5.

**Placeholder scan:** none — every code step is complete. The only "note" states are intentional (ComfyUI templates deferred to 5.3), not TODOs.

**Type consistency:** `NotFoundError` is imported from `flocks-service` everywhere (never redefined). `Actor`/`Db`/`writeAudit` reused from Plan 5.1 verbatim. `savePaddockInput`/`saveFenceInput`/`rateLimitSchema`/`quotaSchema` defined in Task 2/3 and consumed in Tasks 4/6/7. `BlastRadius` defined in Task 5 and consumed by Task 7's page + card. `PADDOCK_THEMES`/`PaddockTheme` defined in Task 1 and consumed in Task 2. The fence upsert `onConflictDoUpdate` target (`fence.paddockId`) matches the `fence_paddock` unique index from Task 1.

**Deliberate decisions (recorded):** `rateLimitSchema`/`quotaSchema` are defined locally in the control-plane rather than shared with the data-plane's `apps/data-plane/src/config/quota.ts` (avoids an app→app dependency; mirrors the Plan 5.1 `buildBreedRegistry` duplication) — a future refactor could hoist both into `@metamodels/schema` or `@metamodels/connectors`; noted as carry-forward. Slug uniqueness is enforced by a friendly pre-check inside the transaction plus the DB `unique` constraint as the race-safe backstop. One-fence-per-paddock is enforced by the new unique index + `onConflictDoUpdate`.
