import { and, eq, gt, isNull, lt, or, type SQL } from 'drizzle-orm'
import { oidcPayload } from '@metamodels/schema'
import type { Adapter, AdapterPayload } from 'oidc-provider'
import type { Db } from './db.js'

/**
 * oidc-provider storage over the `oidc_payload` table. One instance per model name (Session,
 * AccessToken, …); the model namespaces ids. Expired rows are invisible to every lookup and are
 * physically removed by `sweepExpired`.
 */
export class PgAdapter implements Adapter {
  constructor(
    private readonly db: Db,
    private readonly model: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void> {
    const expiresAt = expiresIn ? new Date(this.now().getTime() + expiresIn * 1000) : null
    const columns = {
      payload: payload as unknown,
      grantId: payload.grantId ?? null,
      userCode: payload.userCode ?? null,
      uid: payload.uid ?? null,
      expiresAt,
    }
    // consumed_at is deliberately left out of the update: re-saving a model never un-consumes it.
    await this.db
      .insert(oidcPayload)
      .values({ model: this.model, id, ...columns })
      .onConflictDoUpdate({ target: [oidcPayload.model, oidcPayload.id], set: columns })
  }

  find(id: string): Promise<AdapterPayload | undefined> {
    return this.findWhere(eq(oidcPayload.id, id))
  }

  findByUid(uid: string): Promise<AdapterPayload | undefined> {
    return this.findWhere(eq(oidcPayload.uid, uid))
  }

  findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
    return this.findWhere(eq(oidcPayload.userCode, userCode))
  }

  async consume(id: string): Promise<void> {
    await this.db.update(oidcPayload).set({ consumedAt: this.now() }).where(this.mine(eq(oidcPayload.id, id)))
  }

  async destroy(id: string): Promise<void> {
    await this.db.delete(oidcPayload).where(this.mine(eq(oidcPayload.id, id)))
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    await this.db.delete(oidcPayload).where(this.mine(eq(oidcPayload.grantId, grantId)))
  }

  private mine(cond: SQL): SQL | undefined {
    return and(eq(oidcPayload.model, this.model), cond)
  }

  private async findWhere(cond: SQL): Promise<AdapterPayload | undefined> {
    const rows = await this.db
      .select()
      .from(oidcPayload)
      .where(and(this.mine(cond), or(isNull(oidcPayload.expiresAt), gt(oidcPayload.expiresAt, this.now()))))
      .limit(1)
    const row = rows[0]
    if (!row) return undefined
    const payload = row.payload as AdapterPayload
    return row.consumedAt ? { ...payload, consumed: Math.floor(row.consumedAt.getTime() / 1000) } : payload
  }
}

export function pgAdapterFactory(db: Db, now: () => Date = () => new Date()): (name: string) => Adapter {
  return (name) => new PgAdapter(db, name, now)
}

/** Physically delete every expired row. Returns the number removed. */
export async function sweepExpired(db: Db, now: Date = new Date()): Promise<number> {
  const removed = await db.delete(oidcPayload).where(lt(oidcPayload.expiresAt, now)).returning({ id: oidcPayload.id })
  return removed.length
}
