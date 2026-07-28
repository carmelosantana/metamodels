'use server'
import { revalidatePath } from 'next/cache'
import { getDb } from '../../../server/db'
import { requireUser } from '../../../server/guard'
import { requireCapability } from '../../../auth/authorize'
import { createKey, revokeKey } from '../../../server/keys-service'

export async function createKeyAction(
  _prev: unknown, fd: FormData,
): Promise<{ error?: string; plaintext?: string; prefix?: string }> {
  const actor = await requireUser()
  try {
    requireCapability(actor, 'resource.write')
    const paddockIds = fd.getAll('paddockIds').map(String).filter(Boolean)
    const expiresAt = String(fd.get('expiresAt') ?? '').trim()
    const rlMax = String(fd.get('rateMax') ?? '').trim()
    const rlWindow = String(fd.get('rateWindowSec') ?? '').trim()
    const overrides = rlMax && rlWindow
      ? { rateLimit: { windowSec: Number(rlWindow), max: Number(rlMax) } }
      : undefined
    const created = await createKey(getDb(), actor, {
      name: String(fd.get('name') ?? '').trim(),
      paddockIds,
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
      overrides,
    })
    revalidatePath('/keys')
    return { plaintext: created.plaintext, prefix: created.prefix }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed to create key' }
  }
}

export async function revokeKeyAction(fd: FormData): Promise<{ error?: string }> {
  const actor = await requireUser()
  try {
    requireCapability(actor, 'resource.write')
    await revokeKey(getDb(), actor, String(fd.get('id')))
    revalidatePath('/keys')
    return {}
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed to revoke key' }
  }
}
