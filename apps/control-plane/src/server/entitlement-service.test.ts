import { describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '@metamodels/schema'
import { freshDb, seedOrg, type TestDb } from '../test/db'
import {
  getEntitlement, getDecryptedKey, saveEntitlement, updateValidation, clearEntitlement,
  resolveSeatsForVariant, resolveEntitlementSeats, GRACE_MS,
} from './entitlement-service'
import { decryptLicenseKey } from './license-crypto'
import type { Actor } from '../auth/authorize'

const SECRET = 'entitlement-test-secret-16chars-min'
const NOW = 1_800_000_000_000
const admin = (orgId: string): Actor => ({ id: 'a', orgId, email: 'admin@x.io', role: 'admin' })

describe('entitlement-service', () => {
  test('saveEntitlement encrypts the key (never plaintext), stores last4, and audits', async () => {
    const db = await freshDb(); const o = await seedOrg(db)
    await saveEntitlement(db, admin(o.id), {
      licenseKey: 'ABCD-EFGH-IJKL-WXYZ', instanceId: 'inst_1', status: 'active', seats: 5, tier: 'Team 5',
      lastValidatedAt: new Date(NOW), graceUntil: new Date(NOW + GRACE_MS),
    }, NOW, SECRET)

    const [row] = await db.select().from(schema.entitlement).where(eq(schema.entitlement.orgId, o.id))
    expect(row.licenseKeyEnc).not.toContain('ABCD-EFGH-IJKL-WXYZ')
    expect(row.licenseLast4).toBe('WXYZ')
    expect(row.seats).toBe(5)
    expect(decryptLicenseKey(row.licenseKeyEnc, SECRET)).toBe('ABCD-EFGH-IJKL-WXYZ')

    const view = await getEntitlement(db, o.id)
    expect(view).toMatchObject({ status: 'active', seats: 5, tier: 'Team 5', last4: 'WXYZ' })
    expect((view as unknown as Record<string, unknown>).licenseKeyEnc).toBeUndefined() // never leaks the key

    expect(await getDecryptedKey(db, o.id, SECRET)).toBe('ABCD-EFGH-IJKL-WXYZ')
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'license.activate'))
    expect(audits.length).toBe(1)
  })

  test('saveEntitlement upserts (one row per org)', async () => {
    const db = await freshDb(); const o = await seedOrg(db)
    const base = { licenseKey: 'K1', instanceId: 'i1', status: 'active', seats: 5, tier: 'Team 5', lastValidatedAt: new Date(NOW), graceUntil: new Date(NOW + GRACE_MS) }
    await saveEntitlement(db, admin(o.id), base, NOW, SECRET)
    await saveEntitlement(db, admin(o.id), { ...base, licenseKey: 'K2', seats: 10, tier: 'Team 10' }, NOW, SECRET)
    const rows = await db.select().from(schema.entitlement).where(eq(schema.entitlement.orgId, o.id))
    expect(rows.length).toBe(1)
    expect(rows[0].seats).toBe(10)
  })

  test('updateValidation patches status/seats/grace without touching the key; clearEntitlement removes + audits', async () => {
    const db = await freshDb(); const o = await seedOrg(db)
    await saveEntitlement(db, admin(o.id), { licenseKey: 'K', instanceId: 'i', status: 'active', seats: 5, tier: 'Team 5', lastValidatedAt: new Date(NOW), graceUntil: new Date(NOW + GRACE_MS) }, NOW, SECRET)
    await updateValidation(db, o.id, { status: 'expired', seats: 5, instanceId: 'i', graceUntil: new Date(NOW + GRACE_MS) }, NOW + 1000)
    const v = await getEntitlement(db, o.id)
    expect(v?.status).toBe('expired')
    expect(await getDecryptedKey(db, o.id, SECRET)).toBe('K') // key preserved
    await clearEntitlement(db, admin(o.id))
    expect(await getEntitlement(db, o.id)).toBeNull()
    const audits = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'license.deactivate'))
    expect(audits.length).toBe(1)
  })

  test('resolveSeatsForVariant maps known variants, falls back to base', () => {
    expect(resolveSeatsForVariant('Team 5')).toBe(5)
    expect(resolveSeatsForVariant('Unknown Plan')).toBe(1)
    expect(resolveSeatsForVariant(null)).toBe(1)
  })

  test('resolveEntitlementSeats: active→seats; expired-but-in-grace→seats; expired-past-grace→base', () => {
    expect(resolveEntitlementSeats({ status: 'active', seats: 5, graceUntil: null }, NOW)).toBe(5)
    expect(resolveEntitlementSeats({ status: 'expired', seats: 5, graceUntil: new Date(NOW + 1000) }, NOW)).toBe(5)
    expect(resolveEntitlementSeats({ status: 'expired', seats: 5, graceUntil: new Date(NOW - 1000) }, NOW)).toBe(1)
    expect(resolveEntitlementSeats({ status: 'expired', seats: 5, graceUntil: null }, NOW)).toBe(1)
  })
})
