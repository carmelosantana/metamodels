'use server'
import { revalidatePath } from 'next/cache'
import { getDb } from '../../../server/db'
import { requireUser } from '../../../server/guard'
import { requireCapability } from '../../../auth/authorize'
import { savePaddock, deletePaddock, setPaddockStatus, SlugTakenError } from '../../../server/paddocks-service'
import { NotFoundError } from '../../../server/flocks-service'
import { publishConfigInvalidation } from '../../../server/config-publisher'

export async function savePaddockAction(_prev: unknown, fd: FormData): Promise<{ error?: string; ok?: boolean }> {
  const actor = await requireUser()
  try {
    requireCapability(actor, 'resource.write')
    await savePaddock(getDb(), actor, {
      id: (String(fd.get('id') ?? '') || undefined),
      flockId: String(fd.get('flockId') ?? ''),
      name: String(fd.get('name') ?? '').trim(),
      slug: String(fd.get('slug') ?? '').trim(),
      status: (String(fd.get('status') ?? 'active') as 'active' | 'disabled'),
      theme: (String(fd.get('theme') ?? 'plain') as 'plain' | 'metaboy'),
    })
    revalidatePath('/paddocks')
    await publishConfigInvalidation('paddock.save')
    return { ok: true }
  } catch (e) {
    if (e instanceof SlugTakenError) return { error: e.message }
    if (e instanceof NotFoundError) return { error: 'Selected flock not found in your org.' }
    return { error: e instanceof Error ? e.message : 'Failed to save paddock' }
  }
}

export async function togglePaddockStatusAction(fd: FormData): Promise<void> {
  const actor = await requireUser()
  requireCapability(actor, 'resource.write')
  const next = String(fd.get('status')) === 'active' ? 'disabled' : 'active'
  await setPaddockStatus(getDb(), actor, String(fd.get('id')), next)
  revalidatePath('/paddocks')
  await publishConfigInvalidation('paddock.status')
}

export async function deletePaddockAction(fd: FormData): Promise<void> {
  const actor = await requireUser()
  requireCapability(actor, 'resource.write')
  await deletePaddock(getDb(), actor, String(fd.get('id')))
  revalidatePath('/paddocks')
  await publishConfigInvalidation('paddock.delete')
}
