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
