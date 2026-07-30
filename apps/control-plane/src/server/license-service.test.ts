import { describe, expect, test } from 'vitest'
import { freshDb, seedOrg, type TestDb } from '../test/db'
import type { Db } from './db'
import { activateLicense, deactivateLicense, revalidateLicense, revalidateAllEntitlements } from './license-service'
import { getEntitlement, GRACE_MS } from './entitlement-service'
import { LemonSqueezyClient, type LsResult } from './ls-client'
import type { Actor } from '../auth/authorize'

const SECRET = 'license-service-secret-16chars-min'
const NOW = 1_800_000_000_000
const admin = (orgId: string): Actor => ({ id: 'a', orgId, email: 'admin@x.io', role: 'admin' })

/** A fake LS built from a per-endpoint script (throw to simulate a transport error). */
function fakeLs(script: { activate?: LsResult; validate?: LsResult | (() => never); deactivate?: { deactivated: boolean } | (() => never) }): LemonSqueezyClient {
  return {
    activate: async () => script.activate!,
    validate: async () => { const v = script.validate; if (typeof v === 'function') return v(); return v! },
    deactivate: async () => { const d = script.deactivate; if (typeof d === 'function') return d(); return d ?? { deactivated: true } },
  } as unknown as LemonSqueezyClient
}

describe('license-service', () => {
  test('activateLicense stores an active entitlement with tier seats', async () => {
    const db = await freshDb(); const o = await seedOrg(db)
    const ls = fakeLs({
      activate: { valid: true, status: 'active', instanceId: 'inst_1', variantName: 'Team 5' },
      validate: { valid: true, status: 'active', instanceId: 'inst_1', variantName: 'Team 5' },
    })
    const r = await activateLicense(db, admin(o.id), 'LICENSE-KEY', 'my-box', { ls, secret: SECRET, nowMs: NOW })
    expect(r.ok).toBe(true)
    const v = await getEntitlement(db, o.id)
    expect(v).toMatchObject({ status: 'active', seats: 5, tier: 'Team 5', instanceId: 'inst_1' })
    expect(v?.graceUntil?.getTime()).toBe(NOW + GRACE_MS)
  })

  test('activateLicense returns {ok:false} on an invalid key and stores nothing', async () => {
    const db = await freshDb(); const o = await seedOrg(db)
    const ls = fakeLs({ activate: { valid: false, status: 'inactive', instanceId: null, variantName: null } })
    const r = await activateLicense(db, admin(o.id), 'BAD', 'my-box', { ls, secret: SECRET, nowMs: NOW })
    expect(r.ok).toBe(false)
    expect(await getEntitlement(db, o.id)).toBeNull()
  })

  test('activateLicense gates on the confirming validate: activate ok but validate invalid stores nothing', async () => {
    const db = await freshDb(); const o = await seedOrg(db)
    const ls = fakeLs({
      activate: { valid: true, status: 'active', instanceId: 'inst_1', variantName: 'Team 5' },
      validate: { valid: false, status: 'inactive', instanceId: 'inst_1', variantName: 'Team 5' },
    })
    const r = await activateLicense(db, admin(o.id), 'LICENSE-KEY', 'my-box', { ls, secret: SECRET, nowMs: NOW })
    expect(r.ok).toBe(false)
    expect(await getEntitlement(db, o.id)).toBeNull()
  })

  test('revalidate: a transport error keeps the last-good state (offline grace)', async () => {
    const db = await freshDb(); const o = await seedOrg(db)
    const okLs = fakeLs({
      activate: { valid: true, status: 'active', instanceId: 'i', variantName: 'Team 5' },
      validate: { valid: true, status: 'active', instanceId: 'i', variantName: 'Team 5' },
    })
    await activateLicense(db, admin(o.id), 'K', 'box', { ls: okLs, secret: SECRET, nowMs: NOW })

    const downLs = fakeLs({ validate: () => { throw new Error('ECONNREFUSED') } })
    await revalidateLicense(db, o.id, { ls: downLs, secret: SECRET, nowMs: NOW + 1000 })
    const v = await getEntitlement(db, o.id)
    expect(v?.status).toBe('active')                 // unchanged — grace preserves it
    expect(v?.seats).toBe(5)
  })

  test('revalidate: a definitive valid:false downgrades status (grace clock keeps running)', async () => {
    const db = await freshDb(); const o = await seedOrg(db)
    const okLs = fakeLs({
      activate: { valid: true, status: 'active', instanceId: 'i', variantName: 'Team 5' },
      validate: { valid: true, status: 'active', instanceId: 'i', variantName: 'Team 5' },
    })
    await activateLicense(db, admin(o.id), 'K', 'box', { ls: okLs, secret: SECRET, nowMs: NOW })
    const graceAtActivation = (await getEntitlement(db, o.id))?.graceUntil?.getTime()

    const expiredLs = fakeLs({ validate: { valid: false, status: 'expired', instanceId: 'i', variantName: 'Team 5' } })
    await revalidateLicense(db, o.id, { ls: expiredLs, secret: SECRET, nowMs: NOW + 1000 })
    const v = await getEntitlement(db, o.id)
    expect(v?.status).toBe('expired')
    // graceUntil is unchanged from activation (not reset to nowMs), so seats stay licensed until it lapses, then drop.
    expect(v?.graceUntil?.getTime()).toBe(graceAtActivation)
  })

  test('deactivateLicense clears the entitlement even if LS deactivate fails', async () => {
    const db = await freshDb(); const o = await seedOrg(db)
    const okLs = fakeLs({
      activate: { valid: true, status: 'active', instanceId: 'i', variantName: 'Team 5' },
      validate: { valid: true, status: 'active', instanceId: 'i', variantName: 'Team 5' },
    })
    await activateLicense(db, admin(o.id), 'K', 'box', { ls: okLs, secret: SECRET, nowMs: NOW })
    const downLs = fakeLs({ deactivate: () => { throw new Error('down') } })
    await deactivateLicense(db, admin(o.id), { ls: downLs, secret: SECRET, nowMs: NOW + 5 })
    expect(await getEntitlement(db, o.id)).toBeNull()
  })
})

describe('revalidateAllEntitlements', () => {
  const okLs = () => fakeLs({
    activate: { valid: true, status: 'active', instanceId: 'i', variantName: 'Team 5' },
    validate: { valid: true, status: 'active', instanceId: 'i', variantName: 'Team 5' },
  })

  test('revalidates every entitled org and reports counts', async () => {
    const db = await freshDb()
    const o1 = await seedOrg(db, 'a@x.io')
    const o2 = await seedOrg(db, 'b@x.io')
    await activateLicense(db, admin(o1.id), 'K1', 'box1', { ls: okLs(), secret: SECRET, nowMs: NOW })
    await activateLicense(db, admin(o2.id), 'K2', 'box2', { ls: okLs(), secret: SECRET, nowMs: NOW })

    // A later pass: valid:true again → grace extends to LATER+GRACE_MS for both.
    const LATER = NOW + 60_000
    const res = await revalidateAllEntitlements(db, { ls: okLs(), secret: SECRET, nowMs: LATER })
    expect(res).toEqual({ total: 2, ok: 2, failed: 0 })
    expect((await getEntitlement(db, o1.id))?.graceUntil?.getTime()).toBe(LATER + GRACE_MS)
    expect((await getEntitlement(db, o2.id))?.graceUntil?.getTime()).toBe(LATER + GRACE_MS)
  })

  test('one org failing does not abort the pass (per-org isolation)', async () => {
    const db = await freshDb()
    const o1 = await seedOrg(db, 'a@x.io')
    const o2 = await seedOrg(db, 'b@x.io')
    await activateLicense(db, admin(o1.id), 'K1', 'box1', { ls: okLs(), secret: SECRET, nowMs: NOW })
    await activateLicense(db, admin(o2.id), 'K2', 'box2', { ls: okLs(), secret: SECRET, nowMs: NOW })

    // Inject a revalidate stub that throws for exactly one org id.
    const failFor = o1.id
    const revalidate = async (_db: Db, orgId: string) => {
      if (orgId === failFor) throw new Error('boom')
    }
    const res = await revalidateAllEntitlements(db, { ls: okLs(), secret: SECRET, nowMs: NOW }, revalidate)
    expect(res.total).toBe(2)
    expect(res.ok).toBe(1)
    expect(res.failed).toBe(1)
  })

  test('an empty instance revalidates nothing', async () => {
    const db = await freshDb()
    const res = await revalidateAllEntitlements(db, { ls: okLs(), secret: SECRET, nowMs: NOW })
    expect(res).toEqual({ total: 0, ok: 0, failed: 0 })
  })
})
