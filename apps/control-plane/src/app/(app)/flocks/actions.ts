'use server'
import { revalidatePath } from 'next/cache'
import { getDb } from '../../../server/db'
import { requireUser } from '../../../server/guard'
import { requireCapability } from '../../../auth/authorize'
import { saveFlock, deleteFlock } from '../../../server/flocks-service'
import { testFlockConnection, listFlockModels, buildBreedRegistry } from '../../../server/flock-health'
import type { ModelListResult } from '@metamodels/connectors'
import { publishConfigInvalidation } from '../../../server/config-publisher'
import { flockFormToInput, saveFlockErrorMessage } from '../../../lib/flock-form'

const registry = buildBreedRegistry()

export async function saveFlockAction(_prev: unknown, fd: FormData): Promise<{ error?: string; ok?: boolean }> {
  const actor = await requireUser()
  try {
    requireCapability(actor, 'resource.write')
    await saveFlock(getDb(), actor, flockFormToInput(fd))
    revalidatePath('/flocks')
    await publishConfigInvalidation('flock.save')
    return { ok: true }
  } catch (e) {
    return { error: saveFlockErrorMessage(e) }
  }
}

export async function deleteFlockAction(fd: FormData): Promise<void> {
  const actor = await requireUser()
  requireCapability(actor, 'resource.write')
  await deleteFlock(getDb(), actor, String(fd.get('id')))
  revalidatePath('/flocks')
  await publishConfigInvalidation('flock.delete')
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

export async function listFlockModelsAction(flockId: string): Promise<ModelListResult> {
  const actor = await requireUser()
  requireCapability(actor, 'read')
  return listFlockModels(registry, getDb(), actor, flockId)
}
