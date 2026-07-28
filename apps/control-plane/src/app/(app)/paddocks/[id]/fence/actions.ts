'use server'
import { revalidatePath } from 'next/cache'
import { getDb } from '../../../../../server/db'
import { requireUser } from '../../../../../server/guard'
import { requireCapability } from '../../../../../auth/authorize'
import { saveFence } from '../../../../../server/fences-service'
import { buildBreedRegistry } from '../../../../../server/flock-health'
import { publishConfigInvalidation } from '../../../../../server/config-publisher'

const registry = buildBreedRegistry()

export async function saveFenceAction(_prev: unknown, fd: FormData): Promise<{ error?: string; ok?: boolean }> {
  const actor = await requireUser()
  const paddockId = String(fd.get('paddockId') ?? '')
  const breed = String(fd.get('breed') ?? '')
  try {
    requireCapability(actor, 'resource.write')

    // Build constraint_json per breed from the form.
    // ComfyUI: templates are managed on the Templates screen (8b); omit constraintJson
    // entirely so saveFence preserves whatever templates already exist.
    let constraintJson: unknown
    if (breed !== 'comfyui') {
      const routes = fd.getAll('route').map(String)
      const modelsRaw = String(fd.get('models') ?? '').trim()
      const allowedModels = modelsRaw ? modelsRaw.split(',').map((m) => m.trim()).filter(Boolean) : null
      constraintJson = { allowedRoutes: routes, allowedModels }
    }

    const rlMax = Number(fd.get('rlMax'))
    const rlWindow = Number(fd.get('rlWindow'))
    const rateLimit = rlMax > 0 && rlWindow > 0 ? { windowSec: rlWindow, max: rlMax } : null

    const qDim = String(fd.get('qDim') ?? '')
    const qMax = Number(fd.get('qMax'))
    const qPeriod = String(fd.get('qPeriod') ?? '')
    const quota = qDim && qMax > 0 && qPeriod ? [{ dim: qDim, max: qMax, period: qPeriod }] : null

    await saveFence(getDb(), actor, registry, { paddockId, constraintJson, rateLimit, quota })
    revalidatePath(`/paddocks/${paddockId}/fence`)
    await publishConfigInvalidation('fence.save')
    return { ok: true }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed to save fence' }
  }
}
