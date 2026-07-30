import type { Db } from './db'
import { requireCapability, type Actor } from '../auth/authorize'
import { LemonSqueezyClient } from './ls-client'
import {
  saveEntitlement, updateValidation, clearEntitlement, getEntitlement, getDecryptedKey,
  resolveSeatsForVariant, GRACE_MS, listEntitledOrgIds,
} from './entitlement-service'

export interface LicenseDeps {
  ls: LemonSqueezyClient
  secret: string
  nowMs: number
}

/** Read the license-encryption secret from env (>=16 chars), mirroring current-user.ts#secret. */
export function licenseSecret(): string {
  const s = process.env.LICENSE_KEY_SECRET
  if (!s || s.length < 16) throw new Error('LICENSE_KEY_SECRET must be set (>=16 chars)')
  return s
}

export async function activateLicense(
  db: Db, actor: Actor, licenseKey: string, instanceName: string, deps: LicenseDeps,
): Promise<{ ok: true } | { ok: false; error: string }> {
  requireCapability(actor, 'license.manage')
  let res
  try {
    const activated = await deps.ls.activate(licenseKey, instanceName)
    if (!activated.valid) return { ok: false, error: 'License key could not be activated.' }
    // Confirm + read authoritative status/variant.
    res = await deps.ls.validate(licenseKey, activated.instanceId)
    res = { ...res, instanceId: res.instanceId ?? activated.instanceId }
    if (!res.valid) return { ok: false, error: 'License key is not valid.' }
  } catch {
    return { ok: false, error: 'Could not reach the license server. Try again.' }
  }
  const seats = resolveSeatsForVariant(res.variantName)
  await saveEntitlement(db, actor, {
    licenseKey, instanceId: res.instanceId, status: res.status,
    seats, tier: res.variantName, lastValidatedAt: new Date(deps.nowMs), graceUntil: new Date(deps.nowMs + GRACE_MS),
  }, deps.nowMs, deps.secret)
  return { ok: true }
}

export async function deactivateLicense(db: Db, actor: Actor, deps: LicenseDeps): Promise<void> {
  requireCapability(actor, 'license.manage')
  const view = await getEntitlement(db, actor.orgId)
  const key = await getDecryptedKey(db, actor.orgId, deps.secret)
  if (key && view?.instanceId) {
    try { await deps.ls.deactivate(key, view.instanceId) } catch { /* best-effort — clear locally regardless */ }
  }
  await clearEntitlement(db, actor)
}

/**
 * Offline-grace re-validation. A transport error changes NOTHING (grace preserves the last-good
 * state). Only a definitive LS response updates status/seats/instance; a `valid:false` leaves the
 * grace clock as-is so seats stay licensed until graceUntil lapses, then getSeatLimit drops to base.
 */
export async function revalidateLicense(db: Db, orgId: string, deps: LicenseDeps): Promise<void> {
  const key = await getDecryptedKey(db, orgId, deps.secret)
  const view = await getEntitlement(db, orgId)
  if (!key || !view) return
  let res
  try {
    res = await deps.ls.validate(key, view.instanceId)
  } catch {
    return // transport error — keep last-good state; grace covers it
  }
  const seats = res.valid ? resolveSeatsForVariant(res.variantName) : view.seats
  await updateValidation(db, orgId, {
    status: res.status,
    seats,
    instanceId: res.instanceId ?? view.instanceId,
    // On a fresh valid confirmation, extend grace; on valid:false keep the existing grace clock.
    graceUntil: res.valid ? new Date(deps.nowMs + GRACE_MS) : (view.graceUntil ?? new Date(deps.nowMs)),
  }, deps.nowMs)
}

/**
 * One scheduler pass: revalidate every entitled org's license, isolated per org so a single failure
 * never aborts the rest. `revalidate` is injectable for testing; production uses `revalidateLicense`,
 * whose own try/catch already turns a transport error into a no-op (grace preserves last-good state).
 */
export async function revalidateAllEntitlements(
  db: Db,
  deps: LicenseDeps,
  revalidate: (db: Db, orgId: string, deps: LicenseDeps) => Promise<void> = revalidateLicense,
): Promise<{ total: number; ok: number; failed: number }> {
  const orgIds = await listEntitledOrgIds(db)
  let ok = 0
  let failed = 0
  for (const orgId of orgIds) {
    try {
      await revalidate(db, orgId, deps)
      ok++
    } catch (err) {
      failed++
      // eslint-disable-next-line no-console
      console.error(`revalidate failed for org ${orgId}`, err)
    }
  }
  return { total: orgIds.length, ok, failed }
}
