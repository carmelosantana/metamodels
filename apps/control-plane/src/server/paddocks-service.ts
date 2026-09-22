import { and, asc, eq, gt } from 'drizzle-orm'
import { flock, paddock, type Paddock, type PaddockTheme } from '@metamodels/schema'
import type { Db } from './db'
import { requireCapability, type Actor } from '../auth/authorize'
import { writeAudit } from './audit'
import { NotFoundError } from './flocks-service'
import { savePaddockInput } from '../lib/paddock-schema'
import { decodeCursor, type PageOpts } from './page'

export class SlugTakenError extends Error {
  constructor(slug: string) {
    super(`slug already in use: ${slug}`)
    this.name = 'SlugTakenError'
  }
}

export async function listPaddocks(db: Db, actor: Actor, opts?: PageOpts): Promise<Paddock[]> {
  requireCapability(actor, 'read')
  const conds = [eq(paddock.orgId, actor.orgId)]
  // `!== undefined`, not truthiness: an empty cursor is malformed input to reject, not a
  // silent fall back to page one.
  if (opts?.cursor !== undefined) conds.push(gt(paddock.id, decodeCursor(opts.cursor)))
  const q = db.select().from(paddock).where(and(...conds)).orderBy(asc(paddock.id))
  // No `opts` means no pagination at all: the console's pages call this bare and must keep
  // receiving every row.
  return opts ? q.limit(opts.limit) : q
}

/** The single by-id read. In the service, not the handler, so org scoping lives in one place. */
export async function getPaddock(db: Db, actor: Actor, id: string): Promise<Paddock> {
  requireCapability(actor, 'read')
  const rows = await db.select().from(paddock)
    .where(and(eq(paddock.id, id), eq(paddock.orgId, actor.orgId))).limit(1)
  const row = rows[0]
  // Another org's row is "not found", never a 403: whether it exists is itself the leak.
  if (!row) throw new NotFoundError(`paddock ${id}`)
  return row
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

    // `status` is present ONLY when the caller sent one. The key is genuinely absent otherwise,
    // not set to `undefined`: on UPDATE that leaves the column out of the `set()` list, so a
    // caller who does not mention status cannot move it — which is what lets the admin API's
    // item PUT be status-safe INSIDE this transaction rather than by reading the row first and
    // re-asserting it afterwards, a read-modify-write that would lose a concurrent
    // `setPaddockStatus`. On INSERT the column's own notNull().default('active') fills it in.
    // (Measured: drizzle also drops an explicitly-`undefined` key from both `set()` and
    // `values()`, so this is belt-and-braces rather than a workaround.)
    const values = {
      flockId: data.flockId,
      name: data.name,
      slug: data.slug,
      theme: data.theme as PaddockTheme,
      ...(data.status !== undefined ? { status: data.status } : {}),
    }

    if (data.id) {
      const id = data.id
      const [updated] = await tx
        .update(paddock)
        .set(values)
        .where(and(eq(paddock.id, id), eq(paddock.orgId, actor.orgId)))
        .returning()
      if (!updated) throw new NotFoundError(`paddock ${id}`)
      await writeAudit(tx, actor, {
        action: 'paddock.update',
        target: `paddock:${updated.id}`, detail: { slug: updated.slug },
      })
      return updated
    }

    const [created] = await tx.insert(paddock).values({ orgId: actor.orgId, ...values }).returning()
    await writeAudit(tx, actor, {
      action: 'paddock.create',
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
    await writeAudit(tx, actor, {
      action: 'paddock.status',
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
    await writeAudit(tx, actor, {
      action: 'paddock.delete', target: `paddock:${id}`,
    })
  })
}
