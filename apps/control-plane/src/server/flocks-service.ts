import { and, asc, eq, gt, sql } from 'drizzle-orm'
import { flock, type Flock } from '@metamodels/schema'
import { openSealed, seal, UnsealError, type UnsealReason } from '@metamodels/schema/sealed'
import { upstreamAuthKeys } from './seal-keys'
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

/**
 * An update would carry a stored credential somewhere new — a different `baseUrl`, or TLS trust
 * switched on — without the caller re-sending it. Refused, because the credential is write-only
 * against writers too: otherwise a `resource.write` token could point the flock at its own server
 * and have the next model listing or paddock request deliver the credential there.
 */
export class CredentialRebindError extends Error {
  constructor() {
    super('changing baseUrl or enabling tlsTrust on a flock with a stored credential requires ' +
      're-sending upstreamAuth (or null to clear it)')
    this.name = 'CredentialRebindError'
  }
}

/**
 * A flock as this service hands it to ANY caller: the row minus its upstream credential, plus
 * whether one is stored. The credential is write-only. `read` is the scope handed to long-lived CLI
 * tokens, so a read that returned it — sealed or not — would put every upstream credential in the
 * org on an operator's laptop. Projected here, in the one place every route and page goes through,
 * rather than filtered per route, where one forgotten route leaks it again.
 */
export type FlockView = Omit<Flock, 'upstreamAuthEnc'> & { hasUpstreamAuth: boolean }

// An allowlist, not the table's columns minus one: a secret column added later stays out of every
// response until someone deliberately adds it here.
export const flockView = {
  id: flock.id,
  orgId: flock.orgId,
  breed: flock.breed,
  name: flock.name,
  baseUrl: flock.baseUrl,
  tlsTrust: flock.tlsTrust,
  healthOk: flock.healthOk,
  createdAt: flock.createdAt,
  hasUpstreamAuth: sql<boolean>`${flock.upstreamAuthEnc} IS NOT NULL`.as('has_upstream_auth'),
}

export async function listFlocks(db: Db, actor: Actor, opts?: PageOpts): Promise<FlockView[]> {
  requireCapability(actor, 'read')
  const conds = [eq(flock.orgId, actor.orgId)]
  // `!== undefined`, not truthiness: an empty cursor is malformed input to reject, not a
  // silent fall back to page one.
  if (opts?.cursor !== undefined) conds.push(gt(flock.id, decodeCursor(opts.cursor)))
  const q = db.select(flockView).from(flock).where(and(...conds)).orderBy(asc(flock.id))
  // No `opts` means no pagination at all: the console's pages call this bare and must keep
  // receiving every row.
  return opts ? q.limit(opts.limit) : q
}

/** The single by-id read. In the service, not the handler, so org scoping lives in one place. */
export async function getFlock(db: Db, actor: Actor, id: string): Promise<FlockView> {
  requireCapability(actor, 'read')
  const rows = await db.select(flockView).from(flock)
    .where(and(eq(flock.id, id), eq(flock.orgId, actor.orgId))).limit(1)
  const row = rows[0]
  // Another org's row is "not found", never a 403: whether it exists is itself the leak.
  if (!row) throw new NotFoundError(`flock ${id}`)
  return row
}

/** What a server-side caller needs to reach a flock. Holds the OPENED credential: never send it to a client. */
export interface FlockConnection {
  breed: string
  baseUrl: string
  tlsTrust: boolean
  upstreamAuth: string | null
  /** Set when a credential is stored but no held key opens it; `upstreamAuth` is then null. */
  upstreamAuthError?: UnsealReason
}

/**
 * The one place the control plane opens a stored credential, for calls it makes to the flock itself
 * (listing its models). Org-scoped like `getFlock`, and `read`, because what leaves the server is
 * the flock's answer — the credential only travels to the flock's own base URL.
 */
export async function getFlockConnection(db: Db, actor: Actor, id: string): Promise<FlockConnection> {
  requireCapability(actor, 'read')
  const rows = await db
    .select({ breed: flock.breed, baseUrl: flock.baseUrl, tlsTrust: flock.tlsTrust, enc: flock.upstreamAuthEnc })
    .from(flock)
    .where(and(eq(flock.id, id), eq(flock.orgId, actor.orgId))).limit(1)
  const row = rows[0]
  if (!row) throw new NotFoundError(`flock ${id}`)
  const conn = { breed: row.breed, baseUrl: row.baseUrl, tlsTrust: row.tlsTrust }
  if (row.enc === null) return { ...conn, upstreamAuth: null }
  try {
    return { ...conn, upstreamAuth: openSealed(row.enc, upstreamAuthKeys()) }
  } catch (e) {
    if (!(e instanceof UnsealError)) throw e
    return { ...conn, upstreamAuth: null, upstreamAuthError: e.reason }
  }
}

export async function saveFlock(db: Db, actor: Actor, input: unknown): Promise<FlockView> {
  requireCapability(actor, 'resource.write')
  const data = saveFlockInput.parse(input)
  // The credential is tri-state, and an omitted one is left OUT of `values` — the `savePaddock`
  // status pattern — so the UPDATE never names the column. Reads no longer return it, so the old
  // replace semantics (omitted → null) would make every GET → edit → PUT round trip silently
  // destroy it. Omitted: untouched (null on INSERT, the column default). `null`: cleared. A string:
  // sealed under the current key, replacing whatever was there.
  const credential = data.upstreamAuth === undefined
    ? {}
    : { upstreamAuthEnc: data.upstreamAuth === null ? null : seal(data.upstreamAuth, upstreamAuthKeys()) }
  const values = {
    breed: data.breed,
    name: data.name,
    baseUrl: data.baseUrl,
    tlsTrust: data.tlsTrust,
    ...credential,
  }
  // Whether the credential changed is worth an audit trail; its value never is, sealed or not.
  const credentialAudit = data.upstreamAuth === undefined
    ? {}
    : { upstreamAuth: data.upstreamAuth === null ? 'cleared' : 'set' }

  if (data.id) {
    const id = data.id
    return db.transaction(async (tx) => {
      if (data.upstreamAuth === undefined) {
        // Inside the transaction and FOR UPDATE, so the comparison and the write see the same row.
        // Org-scoped, so another org's id stays a 404 below rather than a 409 that confirms it.
        const [current] = await tx
          .select({ baseUrl: flock.baseUrl, tlsTrust: flock.tlsTrust, enc: flock.upstreamAuthEnc })
          .from(flock)
          .where(and(eq(flock.id, id), eq(flock.orgId, actor.orgId)))
          .for('update')
        if (current?.enc != null && (current.baseUrl !== data.baseUrl || (!current.tlsTrust && data.tlsTrust))) {
          throw new CredentialRebindError()
        }
      }
      const [updated] = await tx
        .update(flock)
        .set(values)
        .where(and(eq(flock.id, id), eq(flock.orgId, actor.orgId)))
        .returning(flockView)
      if (!updated) throw new NotFoundError(`flock ${id}`)
      await writeAudit(tx, actor, {
        action: 'flock.update',
        target: `flock:${updated.id}`, detail: { name: updated.name, ...credentialAudit },
      })
      return updated
    })
  }

  return db.transaction(async (tx) => {
    const [created] = await tx.insert(flock).values({ orgId: actor.orgId, ...values }).returning(flockView)
    await writeAudit(tx, actor, {
      action: 'flock.create',
      target: `flock:${created.id}`, detail: { name: created.name, breed: created.breed, ...credentialAudit },
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
