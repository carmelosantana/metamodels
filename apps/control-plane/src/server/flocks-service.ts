import { and, asc, eq, gt } from 'drizzle-orm'
import { flock, type Flock } from '@metamodels/schema'
import type { Db } from './db'
import { requireCapability, type Actor } from '../auth/authorize'
import { writeAudit } from './audit'
import { saveFlockInput } from '../lib/flock-schema'
import { decodeCursor, type PageOpts } from './page'

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`not found: ${what}`)
    this.name = 'NotFoundError'
  }
}

export async function listFlocks(db: Db, actor: Actor, opts?: PageOpts): Promise<Flock[]> {
  requireCapability(actor, 'read')
  const conds = [eq(flock.orgId, actor.orgId)]
  // `!== undefined`, not truthiness: an empty cursor is malformed input to reject, not a
  // silent fall back to page one.
  if (opts?.cursor !== undefined) conds.push(gt(flock.id, decodeCursor(opts.cursor)))
  const q = db.select().from(flock).where(and(...conds)).orderBy(asc(flock.id))
  // No `opts` means no pagination at all: the console's pages call this bare and must keep
  // receiving every row.
  return opts ? q.limit(opts.limit) : q
}

/** The single by-id read. In the service, not the handler, so org scoping lives in one place. */
export async function getFlock(db: Db, actor: Actor, id: string): Promise<Flock> {
  requireCapability(actor, 'read')
  const rows = await db.select().from(flock)
    .where(and(eq(flock.id, id), eq(flock.orgId, actor.orgId))).limit(1)
  const row = rows[0]
  // Another org's row is "not found", never a 403: whether it exists is itself the leak.
  if (!row) throw new NotFoundError(`flock ${id}`)
  return row
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
    const id = data.id
    return db.transaction(async (tx) => {
      const [updated] = await tx
        .update(flock)
        .set(values)
        .where(and(eq(flock.id, id), eq(flock.orgId, actor.orgId)))
        .returning()
      if (!updated) throw new NotFoundError(`flock ${id}`)
      await writeAudit(tx, actor, {
        action: 'flock.update',
        target: `flock:${updated.id}`, detail: { name: updated.name },
      })
      return updated
    })
  }

  return db.transaction(async (tx) => {
    const [created] = await tx.insert(flock).values({ orgId: actor.orgId, ...values }).returning()
    await writeAudit(tx, actor, {
      action: 'flock.create',
      target: `flock:${created.id}`, detail: { name: created.name, breed: created.breed },
    })
    return created
  })
}

export async function deleteFlock(db: Db, actor: Actor, id: string): Promise<void> {
  requireCapability(actor, 'resource.write')
  await db.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(flock)
      .where(and(eq(flock.id, id), eq(flock.orgId, actor.orgId)))
      .returning()
    if (!deleted) throw new NotFoundError(`flock ${id}`)
    await writeAudit(tx, actor, {
      action: 'flock.delete', target: `flock:${id}`,
    })
  })
}
