import { and, eq, inArray } from 'drizzle-orm'
import { apiKey, generateApiKey, keyPaddock, paddock } from '@metamodels/schema'
import type { Db } from './db'
import { requireCapability, type Actor } from '../auth/authorize'
import { writeAudit } from './audit'
import { NotFoundError } from './flocks-service'
import { createKeyInput } from '../lib/key-schema'

export { NotFoundError }

export interface KeyRow {
  id: string
  name: string
  prefix: string
  status: string
  expiresAt: Date | null
  createdAt: Date
  paddockSlugs: string[]
}

export interface CreatedKey {
  id: string
  name: string
  prefix: string
  /** The full secret — surfaced exactly once here; never stored, logged, or listed. */
  plaintext: string
}

export async function listKeys(db: Db, actor: Actor): Promise<KeyRow[]> {
  requireCapability(actor, 'read')
  const keys = await db
    .select({
      id: apiKey.id, name: apiKey.name, prefix: apiKey.prefix,
      status: apiKey.status, expiresAt: apiKey.expiresAt, createdAt: apiKey.createdAt,
    })
    .from(apiKey)
    .where(eq(apiKey.orgId, actor.orgId))
  if (keys.length === 0) return []

  // Scope slugs per key, org-scoped on the paddock join (defense in depth).
  const links = await db
    .select({ keyId: keyPaddock.keyId, slug: paddock.slug })
    .from(keyPaddock)
    .innerJoin(paddock, eq(keyPaddock.paddockId, paddock.id))
    .where(and(inArray(keyPaddock.keyId, keys.map((k) => k.id)), eq(paddock.orgId, actor.orgId)))
  const bySlug = new Map<string, string[]>()
  for (const l of links) {
    const arr = bySlug.get(l.keyId) ?? []
    arr.push(l.slug)
    bySlug.set(l.keyId, arr)
  }

  return keys.map((k) => ({
    ...k,
    paddockSlugs: (bySlug.get(k.id) ?? []).sort(),
  }))
}

export async function createKey(db: Db, actor: Actor, input: unknown): Promise<CreatedKey> {
  requireCapability(actor, 'resource.write')
  const data = createKeyInput.parse(input)
  const ids = [...new Set(data.paddockIds)]
  const secret = generateApiKey()

  return db.transaction(async (tx) => {
    // Org consistency: every scoped paddock must belong to the actor's org.
    const owned = await tx
      .select({ id: paddock.id })
      .from(paddock)
      .where(and(eq(paddock.orgId, actor.orgId), inArray(paddock.id, ids)))
    if (owned.length !== ids.length) throw new NotFoundError('paddock (cross-org or missing)')

    const [created] = await tx
      .insert(apiKey)
      .values({
        orgId: actor.orgId,
        name: data.name,
        prefix: secret.prefix,
        hash: secret.hash,
        status: 'active',
        expiresAt: data.expiresAt ? new Date(data.expiresAt) : null,
        overrides: (data.overrides ?? null) as never,
      })
      .returning()

    await tx.insert(keyPaddock).values(ids.map((pid) => ({ keyId: created.id, paddockId: pid })))

    await writeAudit(tx, {
      orgId: actor.orgId, actor: actor.email, action: 'key.create',
      target: `key:${created.id}`, detail: { name: created.name, paddocks: ids.length },
    })

    return { id: created.id, name: created.name, prefix: created.prefix, plaintext: secret.plaintext }
  })
}

export async function revokeKey(db: Db, actor: Actor, id: string): Promise<void> {
  requireCapability(actor, 'resource.write')
  await db.transaction(async (tx) => {
    const [revoked] = await tx
      .update(apiKey)
      .set({ status: 'revoked' })
      .where(and(eq(apiKey.id, id), eq(apiKey.orgId, actor.orgId)))
      .returning()
    if (!revoked) throw new NotFoundError(`key ${id}`)
    await writeAudit(tx, {
      orgId: actor.orgId, actor: actor.email, action: 'key.revoke', target: `key:${id}`,
    })
  })
}
