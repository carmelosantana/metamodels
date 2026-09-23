import { and, asc, eq, gt, inArray } from 'drizzle-orm'
import { apiKey, generateApiKey, keyPaddock, paddock } from '@metamodels/schema'
import type { Db } from './db'
import { requireCapability, type Actor } from '../auth/authorize'
import { writeAudit } from './audit'
import { NotFoundError } from './flocks-service'
import { createKeyInput } from '../lib/key-schema'
import { decodeCursor, type PageOpts } from './page'

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

export async function listKeys(db: Db, actor: Actor, opts?: PageOpts): Promise<KeyRow[]> {
  requireCapability(actor, 'read')
  // The page is taken here, on the key query that drives the whole result — one row per key.
  // Limiting the slug join below instead would cut the page short whenever a key is scoped to
  // more than one paddock.
  const conds = [eq(apiKey.orgId, actor.orgId)]
  // `!== undefined`, not truthiness: an empty cursor is malformed input to reject, not a
  // silent fall back to page one.
  if (opts?.cursor !== undefined) conds.push(gt(apiKey.id, decodeCursor(opts.cursor)))
  const keyQuery = db
    .select({
      id: apiKey.id, name: apiKey.name, prefix: apiKey.prefix,
      status: apiKey.status, expiresAt: apiKey.expiresAt, createdAt: apiKey.createdAt,
    })
    .from(apiKey)
    .where(and(...conds))
    .orderBy(asc(apiKey.id))
  // No `opts` means no pagination at all: the console's pages call this bare and must keep
  // receiving every row.
  const keys = await (opts ? keyQuery.limit(opts.limit) : keyQuery)
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

    await writeAudit(tx, actor, {
      action: 'key.create',
      target: `key:${created.id}`, detail: { name: created.name, paddocks: ids.length },
    })

    return { id: created.id, name: created.name, prefix: created.prefix, plaintext: secret.plaintext }
  })
}

/**
 * Retires a key. Idempotent in both halves spec §3 asks for: 204 on a replay, and NO second
 * `key.revoke` audit row for a call that changed nothing.
 *
 * The `status = 'active'` predicate is a TEST-AND-SET, and that is the whole mechanism — not a
 * tidier way to spell a pre-read. Postgres evaluates it while holding the row lock, so of two
 * concurrent revokes exactly one UPDATE matches and exactly one audit row is written. Reading the
 * status first and branching in TypeScript would look equivalent and would not be: both readers
 * could see 'active' and both would audit, which is the duplicate this fix removes, narrowed to a
 * race window rather than removed.
 *
 * Matching no row is therefore ambiguous — already revoked, another org's, or never existed — and
 * the three must not be collapsed. The follow-up SELECT is org-scoped, so:
 *
 *   - the key exists in THIS org → it was already revoked. Return quietly: the key is in the state
 *     the caller asked for, and throwing here would 404 a key they just successfully retired.
 *   - anything else → `NotFoundError`. A foreign key is indistinguishable from a nonexistent one,
 *     deliberately: were an already-revoked foreign key to take the quiet branch, the response
 *     would leak another org's key status.
 *
 * It costs one extra SELECT only on the path where nothing was written.
 */
export async function revokeKey(db: Db, actor: Actor, id: string): Promise<void> {
  requireCapability(actor, 'resource.write')
  await db.transaction(async (tx) => {
    const [revoked] = await tx
      .update(apiKey)
      .set({ status: 'revoked' })
      .where(and(eq(apiKey.id, id), eq(apiKey.orgId, actor.orgId), eq(apiKey.status, 'active')))
      .returning()
    if (!revoked) {
      const [mine] = await tx
        .select({ id: apiKey.id })
        .from(apiKey)
        .where(and(eq(apiKey.id, id), eq(apiKey.orgId, actor.orgId)))
        .limit(1)
      if (!mine) throw new NotFoundError(`key ${id}`)
      return // already revoked: nothing changed, so there is nothing to audit
    }
    await writeAudit(tx, actor, {
      action: 'key.revoke', target: `key:${id}`,
    })
  })
}
