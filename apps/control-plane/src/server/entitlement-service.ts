import { eq } from 'drizzle-orm'
import { entitlement } from '@metamodels/schema'
import type { Db } from './db'
import { requireCapability, type Actor } from '../auth/authorize'
import { writeAudit } from './audit'
import { encryptLicenseKey, decryptLicenseKey, licenseLast4 } from './license-crypto'
import { BASE_SEATS } from './seats'

export { BASE_SEATS }
export const GRACE_MS = 7 * 24 * 60 * 60 * 1000

/** LS variant name → seat count. Operator edits this to match their Lemon Squeezy store. */
export const TIER_SEATS: Record<string, number> = {
  'Team 5': 5,
  'Team 10': 10,
}

export function resolveSeatsForVariant(variantName: string | null): number {
  if (!variantName) return BASE_SEATS
  return TIER_SEATS[variantName] ?? BASE_SEATS
}

/** PURE: effective seat count. Licensed while active OR within the offline-grace window; else base. */
export function resolveEntitlementSeats(
  e: { status: string; seats: number; graceUntil: Date | null }, nowMs: number,
): number {
  if (e.status === 'active') return e.seats
  if (e.graceUntil && e.graceUntil.getTime() > nowMs) return e.seats
  return BASE_SEATS
}

export interface EntitlementView {
  status: string
  seats: number
  tier: string | null
  instanceId: string | null
  last4: string
  lastValidatedAt: Date | null
  graceUntil: Date | null
}

export async function getEntitlement(db: Db, orgId: string): Promise<EntitlementView | null> {
  const [row] = await db.select({
    status: entitlement.status, seats: entitlement.seats, tier: entitlement.tier,
    instanceId: entitlement.instanceId, last4: entitlement.licenseLast4,
    lastValidatedAt: entitlement.lastValidatedAt, graceUntil: entitlement.graceUntil,
  }).from(entitlement).where(eq(entitlement.orgId, orgId)).limit(1)
  return row ?? null
}

/** Background enumerator: every org that has an entitlement row (i.e. a license key to revalidate).
 *  Deliberately NOT org-scoped / capability-gated — it takes no actor and is only reachable from the
 *  server-internal revalidation scheduler, never a request handler. */
export async function listEntitledOrgIds(db: Db): Promise<string[]> {
  const rows = await db.select({ orgId: entitlement.orgId }).from(entitlement)
  return rows.map((r) => r.orgId)
}

/** Server-internal: decrypt the stored key for a re-validate call. Never exposed to a client. */
export async function getDecryptedKey(db: Db, orgId: string, secret: string): Promise<string | null> {
  const [row] = await db.select({ enc: entitlement.licenseKeyEnc }).from(entitlement).where(eq(entitlement.orgId, orgId)).limit(1)
  return row ? decryptLicenseKey(row.enc, secret) : null
}

export interface SaveEntitlementInput {
  licenseKey: string
  instanceId: string | null
  status: string
  seats: number
  tier: string | null
  lastValidatedAt: Date
  graceUntil: Date
}

export async function saveEntitlement(
  db: Db, actor: Actor, input: SaveEntitlementInput, _nowMs: number, secret: string,
): Promise<void> {
  requireCapability(actor, 'license.manage')
  const licenseKeyEnc = encryptLicenseKey(input.licenseKey, secret)
  const last4 = licenseLast4(input.licenseKey)
  await db.transaction(async (tx) => {
    await tx.insert(entitlement).values({
      orgId: actor.orgId, licenseKeyEnc, licenseLast4: last4, instanceId: input.instanceId,
      status: input.status, seats: input.seats, tier: input.tier,
      lastValidatedAt: input.lastValidatedAt, graceUntil: input.graceUntil,
    }).onConflictDoUpdate({
      target: entitlement.orgId,
      set: {
        licenseKeyEnc, licenseLast4: last4, instanceId: input.instanceId, status: input.status,
        seats: input.seats, tier: input.tier, lastValidatedAt: input.lastValidatedAt, graceUntil: input.graceUntil,
      },
    })
    await writeAudit(tx, {
      orgId: actor.orgId, actor: actor.email, action: 'license.activate',
      target: `entitlement:${actor.orgId}`, detail: { tier: input.tier, seats: input.seats, last4 },
    })
  })
}

export interface ValidationPatch {
  status: string
  seats: number
  instanceId: string | null
  graceUntil: Date
}

/** Update validation state after a (re)validate. Does not touch the encrypted key. Org-scoped, not audited (routine). */
export async function updateValidation(db: Db, orgId: string, patch: ValidationPatch, nowMs: number): Promise<void> {
  await db.update(entitlement).set({
    status: patch.status, seats: patch.seats, instanceId: patch.instanceId,
    lastValidatedAt: new Date(nowMs), graceUntil: patch.graceUntil,
  }).where(eq(entitlement.orgId, orgId))
}

export async function clearEntitlement(db: Db, actor: Actor): Promise<void> {
  requireCapability(actor, 'license.manage')
  await db.transaction(async (tx) => {
    await tx.delete(entitlement).where(eq(entitlement.orgId, actor.orgId))
    await writeAudit(tx, {
      orgId: actor.orgId, actor: actor.email, action: 'license.deactivate', target: `entitlement:${actor.orgId}`,
    })
  })
}
