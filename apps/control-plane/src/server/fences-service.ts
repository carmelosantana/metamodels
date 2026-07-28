import { and, eq } from 'drizzle-orm'
import type { BreedRegistry } from '@metamodels/connectors'
import { fence, flock, paddock, type Fence } from '@metamodels/schema'
import type { Db } from './db'
import { requireCapability, type Actor } from '../auth/authorize'
import { writeAudit } from './audit'
import { NotFoundError } from './flocks-service'
import { saveFenceInput } from '../lib/fence-schema'
import { validateConstraintForBreed } from './fence-validation'

export { NotFoundError }

/** Load a paddock scoped to the actor's org, returning its breed. Throws NotFoundError otherwise. */
export async function paddockBreedInOrg(tx: Db, actor: Actor, paddockId: string): Promise<string> {
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
    const provided = data.constraintJson !== undefined

    // Resolve the constraint to store on INSERT: provided → validate it;
    // omitted → existing row's constraint, else the breed default.
    let insertConstraint: unknown
    if (provided) {
      insertConstraint = validateConstraintForBreed(registry, breedId, data.constraintJson)
    } else {
      const [existing] = await tx.select().from(fence).where(eq(fence.paddockId, data.paddockId)).limit(1)
      insertConstraint = existing
        ? existing.constraintJson
        : registry.get(breedId).constraintSchema.parse({}) // breed default (comfyui → {templates:[]})
    }

    // On CONFLICT, only overwrite constraint_json when the caller actually sent one.
    const conflictSet: Record<string, unknown> = {
      rateLimit: (data.rateLimit ?? null) as never,
      quota: (data.quota ?? null) as never,
    }
    if (provided) conflictSet.constraintJson = insertConstraint as never

    const [saved] = await tx
      .insert(fence)
      .values({
        orgId: actor.orgId,
        paddockId: data.paddockId,
        constraintJson: insertConstraint as never,
        rateLimit: (data.rateLimit ?? null) as never,
        quota: (data.quota ?? null) as never,
      })
      .onConflictDoUpdate({ target: fence.paddockId, set: conflictSet })
      .returning()

    await writeAudit(tx, {
      orgId: actor.orgId, actor: actor.email, action: 'fence.save',
      target: `paddock:${data.paddockId}`, detail: { breed: breedId },
    })
    return saved
  })
}
