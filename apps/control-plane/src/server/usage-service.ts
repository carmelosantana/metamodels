import { and, desc, eq, gte, lte, sql } from 'drizzle-orm'
import { apiKey, METER_DIMS, paddock, usageRollup, type MeterDim } from '@metamodels/schema'
import type { Db } from './db'
import { requireCapability, type Actor } from '../auth/authorize'

export interface UsageMatrixRow {
  keyId: string
  keyName: string
  keyPrefix: string
  paddockId: string
  paddockSlug: string
  dims: Record<MeterDim, number>
}

export interface DailyPoint { day: string; value: number }
export interface TopKeyRow { keyId: string; keyName: string; keyPrefix: string; value: number }

const dayExpr = sql<string>`substring(${usageRollup.period} from 1 for 10)`

function zeroDims(): Record<MeterDim, number> {
  return Object.fromEntries(METER_DIMS.map((d) => [d, 0])) as Record<MeterDim, number>
}

export async function usageMatrix(
  db: Db, actor: Actor,
  opts: { startBucket: string; endBucket: string; keyId?: string; paddockId?: string },
): Promise<UsageMatrixRow[]> {
  requireCapability(actor, 'read')
  const conds = [
    eq(usageRollup.orgId, actor.orgId),
    gte(usageRollup.period, opts.startBucket),
    lte(usageRollup.period, opts.endBucket),
  ]
  if (opts.keyId) conds.push(eq(usageRollup.keyId, opts.keyId))
  if (opts.paddockId) conds.push(eq(usageRollup.paddockId, opts.paddockId))

  const rows = await db
    .select({
      keyId: usageRollup.keyId,
      keyName: apiKey.name,
      keyPrefix: apiKey.prefix,
      paddockId: usageRollup.paddockId,
      paddockSlug: paddock.slug,
      dim: usageRollup.dim,
      total: sql<number>`sum(${usageRollup.value})`,
    })
    .from(usageRollup)
    .innerJoin(apiKey, eq(apiKey.id, usageRollup.keyId))
    .innerJoin(paddock, eq(paddock.id, usageRollup.paddockId))
    .where(and(...conds))
    .groupBy(usageRollup.keyId, apiKey.name, apiKey.prefix, usageRollup.paddockId, paddock.slug, usageRollup.dim)

  // Pivot (keyId,paddockId) → dims. Deterministic order: keyName then paddockSlug.
  const byPair = new Map<string, UsageMatrixRow>()
  for (const r of rows) {
    const mapKey = `${r.keyId}|${r.paddockId}`
    let row = byPair.get(mapKey)
    if (!row) {
      row = {
        keyId: r.keyId, keyName: r.keyName, keyPrefix: r.keyPrefix,
        paddockId: r.paddockId, paddockSlug: r.paddockSlug, dims: zeroDims(),
      }
      byPair.set(mapKey, row)
    }
    if ((METER_DIMS as readonly string[]).includes(r.dim)) row.dims[r.dim as MeterDim] = Number(r.total)
  }
  return [...byPair.values()].sort(
    (a, b) => a.keyName.localeCompare(b.keyName) || a.paddockSlug.localeCompare(b.paddockSlug),
  )
}

export async function dailySeries(
  db: Db, actor: Actor,
  opts: { dim: MeterDim; startBucket: string; endBucket: string; keyId?: string; paddockId?: string },
): Promise<DailyPoint[]> {
  requireCapability(actor, 'read')
  const conds = [
    eq(usageRollup.orgId, actor.orgId),
    eq(usageRollup.dim, opts.dim),
    gte(usageRollup.period, opts.startBucket),
    lte(usageRollup.period, opts.endBucket),
  ]
  if (opts.keyId) conds.push(eq(usageRollup.keyId, opts.keyId))
  if (opts.paddockId) conds.push(eq(usageRollup.paddockId, opts.paddockId))

  const rows = await db
    .select({ day: dayExpr, total: sql<number>`sum(${usageRollup.value})` })
    .from(usageRollup)
    .where(and(...conds))
    .groupBy(dayExpr)
    .orderBy(dayExpr)
  return rows.map((r) => ({ day: r.day, value: Number(r.total) }))
}

export async function topKeys(
  db: Db, actor: Actor,
  opts: { dim: MeterDim; startBucket: string; endBucket: string; limit: number },
): Promise<TopKeyRow[]> {
  requireCapability(actor, 'read')
  const rows = await db
    .select({
      keyId: usageRollup.keyId,
      keyName: apiKey.name,
      keyPrefix: apiKey.prefix,
      total: sql<number>`sum(${usageRollup.value})`,
    })
    .from(usageRollup)
    .innerJoin(apiKey, eq(apiKey.id, usageRollup.keyId))
    .where(and(
      eq(usageRollup.orgId, actor.orgId),
      eq(usageRollup.dim, opts.dim),
      gte(usageRollup.period, opts.startBucket),
      lte(usageRollup.period, opts.endBucket),
    ))
    .groupBy(usageRollup.keyId, apiKey.name, apiKey.prefix)
    .orderBy(desc(sql`sum(${usageRollup.value})`))
    .limit(opts.limit)
  return rows.map((r) => ({ keyId: r.keyId, keyName: r.keyName, keyPrefix: r.keyPrefix, value: Number(r.total) }))
}

export async function sumDimSince(
  db: Db, actor: Actor, dim: MeterDim, sinceBucket: string,
): Promise<number> {
  requireCapability(actor, 'read')
  const rows = await db
    .select({ total: sql<number>`coalesce(sum(${usageRollup.value}), 0)` })
    .from(usageRollup)
    .where(and(
      eq(usageRollup.orgId, actor.orgId),
      eq(usageRollup.dim, dim),
      gte(usageRollup.period, sinceBucket),
    ))
  return Number(rows[0]?.total ?? 0)
}
