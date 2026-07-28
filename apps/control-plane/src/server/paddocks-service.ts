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
