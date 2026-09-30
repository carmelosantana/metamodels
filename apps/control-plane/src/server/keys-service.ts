import { randomBytes } from 'node:crypto'
import { and, asc, eq, gt, inArray } from 'drizzle-orm'
import { apiKey, generateApiKey, hashApiKey, keyPaddock, paddock } from '@metamodels/schema'
import type { Db } from './db'
import { authorize, requireCapability, type Actor } from '../auth/authorize'
import { writeAudit } from './audit'
import { NotFoundError } from './flocks-service'
import { createKeyInput } from '../lib/key-schema'
import { acquireOrgLock } from './org-lock'
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
  /** `live` (an `mm_live_` key) or `oauth` (minted at MCP consent; see `mintOauthKey`). */
  kind: string
  /** The approved CIMD client for an oauth key; null for a live key. */
  oauthClientId: string | null
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
      kind: apiKey.kind, oauthClientId: apiKey.oauthClientId,
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

/** What an oauth key shows where an `mm_live_` key shows its prefix: it has no presentable secret. */
export const OAUTH_KEY_PREFIX = 'oauth'
const KEY_NAME_MAX = 120

/** `"<client_name> (MCP) · <user email>"`, cut at 120 characters (M4 D1). */
export function oauthKeyName(clientName: string, email: string): string {
  return `${clientName} (MCP) · ${email}`.slice(0, KEY_NAME_MAX)
}

export interface MintOauthKeyInput {
  /** The CIMD client_id: an https URL, validated by the OP. */
  clientId: string
  /** Self-asserted by the client's metadata document; used only in the key's name. */
  clientName: string
  paddockSlug: string
  /** The OP grant the key is bound to, and that the OP will name the key under. */
  grantId: string
}

export interface MintedOauthKey {
  keyId: string
  outcome: 'created' | 'rebound'
}

/**
 * The consent-time mint (M4 D1). An oauth key is an ordinary `api_key` row, so everything that
 * limits or bills a caller — rollups, jobs, the rate limiter, `key_paddock` scoping, the Keys page —
 * works for MCP callers unchanged. It has no owner-held secret: the hash is of 32 random bytes that
 * are discarded here, so there is nothing to present, log or show.
 *
 * Idempotent per (user, client, paddock), under the per-org lock: the paddock lives in
 * `key_paddock`, so no unique index can express this. A second consent rebinds the existing ACTIVE
 * key to the new grant (`key.rebind`) rather than minting another. A revoked key is never rebound —
 * revocation is the operator's decision and consent does not undo it.
 */
export async function mintOauthKey(db: Db, actor: Actor, input: MintOauthKeyInput): Promise<MintedOauthKey> {
  requireCapability(actor, 'resource.write')
  return db.transaction(async (tx) => {
    await acquireOrgLock(tx, actor.orgId)
    const [p] = await tx
      .select({ id: paddock.id })
      .from(paddock)
      .where(and(eq(paddock.orgId, actor.orgId), eq(paddock.slug, input.paddockSlug), eq(paddock.status, 'active')))
      .limit(1)
    if (!p) throw new NotFoundError(`paddock ${input.paddockSlug}`)

    const [existing] = await tx
      .select({ id: apiKey.id })
      .from(apiKey)
      .innerJoin(keyPaddock, eq(keyPaddock.keyId, apiKey.id))
      .where(and(
        eq(apiKey.orgId, actor.orgId), eq(apiKey.kind, 'oauth'), eq(apiKey.status, 'active'),
        eq(apiKey.userId, actor.id), eq(apiKey.oauthClientId, input.clientId), eq(keyPaddock.paddockId, p.id),
      ))
      .limit(1)
    if (existing) {
      await tx.update(apiKey).set({ grantId: input.grantId }).where(eq(apiKey.id, existing.id))
      await writeAudit(tx, actor, {
        action: 'key.rebind', target: `key:${existing.id}`, detail: { kind: 'oauth', client_id: input.clientId },
      })
      return { keyId: existing.id, outcome: 'rebound' }
    }

    const [created] = await tx
      .insert(apiKey)
      .values({
        orgId: actor.orgId,
        name: oauthKeyName(input.clientName, actor.email),
        prefix: OAUTH_KEY_PREFIX,
        hash: hashApiKey(randomBytes(32).toString('base64url')),
        status: 'active',
        kind: 'oauth',
        grantId: input.grantId,
        oauthClientId: input.clientId,
        userId: actor.id,
      })
      .returning({ id: apiKey.id })
    await tx.insert(keyPaddock).values({ keyId: created.id, paddockId: p.id })
    await writeAudit(tx, actor, {
      action: 'key.create', target: `key:${created.id}`, detail: { kind: 'oauth', client_id: input.clientId },
    })
    return { keyId: created.id, outcome: 'created' }
  })
}

export type OauthPreflight = { allowed: true; reason: null } | { allowed: false; reason: string }

export const PREFLIGHT_NO_CAPABILITY =
  'Your role cannot approve apps. Ask an admin or a member of your organization to connect this one.'
export const PREFLIGHT_NO_PADDOCK =
  'This paddock does not exist, is disabled, or is not in your organization.'

/**
 * Would `mintOauthKey` succeed for this actor and paddock? Read-only: the consent screen asks before
 * it renders an Approve button (M4 §3.3), so a viewer sees a plain refusal rather than a button that
 * fails. An unknown, disabled and foreign paddock share one answer, so the screen reveals nothing
 * about another org's paddocks.
 */
export async function preflightOauthKey(db: Db, actor: Actor, paddockSlug: string | null): Promise<OauthPreflight> {
  if (!authorize(actor, 'resource.write')) return { allowed: false, reason: PREFLIGHT_NO_CAPABILITY }
  if (paddockSlug === null) return { allowed: false, reason: PREFLIGHT_NO_PADDOCK }
  const [p] = await db
    .select({ id: paddock.id })
    .from(paddock)
    .where(and(eq(paddock.orgId, actor.orgId), eq(paddock.slug, paddockSlug), eq(paddock.status, 'active')))
    .limit(1)
  return p ? { allowed: true, reason: null } : { allowed: false, reason: PREFLIGHT_NO_PADDOCK }
}

/**
 * Revokes every active oauth key `userId` approved, with one `key.revoke` audit row each, and returns
 * how many. It checks no capability: call it only inside a `users-service` transaction that already
 * required `user.manage` and holds the org lock. This keeps D3 true after the fact — a user who can
 * no longer approve apps no longer has any approved.
 */
export async function revokeOauthKeysForUser(
  tx: Db, actor: Actor, userId: string, reason: 'user.deactivate' | 'user.role',
): Promise<number> {
  const revoked = await tx
    .update(apiKey)
    .set({ status: 'revoked' })
    .where(and(
      eq(apiKey.orgId, actor.orgId), eq(apiKey.userId, userId), eq(apiKey.kind, 'oauth'), eq(apiKey.status, 'active'),
    ))
    .returning({ id: apiKey.id })
  for (const k of revoked) {
    await writeAudit(tx, actor, { action: 'key.revoke', target: `key:${k.id}`, detail: { kind: 'oauth', reason } })
  }
  return revoked.length
}
