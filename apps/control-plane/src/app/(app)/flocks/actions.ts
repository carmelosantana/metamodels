'use server'
import { revalidatePath } from 'next/cache'
import { getDb } from '../../../server/db'
import { requireUser } from '../../../server/guard'
import { requireCapability } from '../../../auth/authorize'
import { saveFlock, deleteFlock } from '../../../server/flocks-service'
import { testFlockConnection, buildBreedRegistry } from '../../../server/flock-health'

const registry = buildBreedRegistry()

function formToInput(fd: FormData) {
  const id = String(fd.get('id') ?? '')
  const upstreamAuth = String(fd.get('upstreamAuth') ?? '').trim()
  return {
    id: id || undefined,
    breed: String(fd.get('breed') ?? ''),
    name: String(fd.get('name') ?? '').trim(),
    baseUrl: String(fd.get('baseUrl') ?? '').trim(),
    upstreamAuth: upstreamAuth || null,
    tlsTrust: String(fd.get('tlsTrust') ?? 'false') === 'true',
  }
}

export async function saveFlockAction(_prev: unknown, fd: FormData): Promise<{ error?: string; ok?: boolean }> {
  const actor = await requireUser()
  try {
    requireCapability(actor, 'resource.write')
    await saveFlock(getDb(), actor, formToInput(fd))
    revalidatePath('/flocks')
    return { ok: true }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed to save flock' }
  }
}

export async function deleteFlockAction(fd: FormData): Promise<void> {
  const actor = await requireUser()
  requireCapability(actor, 'resource.write')
  await deleteFlock(getDb(), actor, String(fd.get('id')))
  revalidatePath('/flocks')
}

export async function testConnectionAction(fd: FormData): Promise<{ ok: boolean; detail?: string }> {
  const actor = await requireUser()
  requireCapability(actor, 'resource.write')
  return testFlockConnection(registry, {
    breed: String(fd.get('breed') ?? ''),
    baseUrl: String(fd.get('baseUrl') ?? '').trim(),
    upstreamAuth: (String(fd.get('upstreamAuth') ?? '').trim() || null),
    tlsTrust: String(fd.get('tlsTrust') ?? 'false') === 'true',
  })
}
