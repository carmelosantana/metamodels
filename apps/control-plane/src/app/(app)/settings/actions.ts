'use server'
import { revalidatePath } from 'next/cache'
import { getDb } from '../../../server/db'
import { requireUser } from '../../../server/guard'
import { requireCapability } from '../../../auth/authorize'
import { activateLicense, deactivateLicense, revalidateLicense, licenseSecret } from '../../../server/license-service'
import { LemonSqueezyClient } from '../../../server/ls-client'

function deps() {
  return { ls: new LemonSqueezyClient(), secret: licenseSecret(), nowMs: Date.now() }
}

export async function activateLicenseAction(_prev: unknown, fd: FormData): Promise<{ error?: string; ok?: boolean }> {
  const actor = await requireUser()
  try {
    requireCapability(actor, 'license.manage')
    const key = String(fd.get('licenseKey') ?? '').trim()
    const instanceName = String(fd.get('instanceName') ?? '').trim() || 'metamodels'
    const r = await activateLicense(getDb(), actor, key, instanceName, deps())
    if (!r.ok) return { error: r.error }
    revalidatePath('/settings')
    return { ok: true }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed to activate license' }
  }
}

export async function deactivateLicenseAction(): Promise<{ error?: string }> {
  const actor = await requireUser()
  try {
    requireCapability(actor, 'license.manage')
    await deactivateLicense(getDb(), actor, deps())
    revalidatePath('/settings')
    return {}
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed to deactivate license' }
  }
}

export async function revalidateLicenseAction(): Promise<{ error?: string }> {
  const actor = await requireUser()
  try {
    requireCapability(actor, 'license.manage')
    await revalidateLicense(getDb(), actor.orgId, deps())
    revalidatePath('/settings')
    return {}
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed to revalidate license' }
  }
}
