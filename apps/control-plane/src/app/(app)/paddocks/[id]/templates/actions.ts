'use server'
import { revalidatePath } from 'next/cache'
import { getDb } from '../../../../../server/db'
import { requireUser } from '../../../../../server/guard'
import { requireCapability } from '../../../../../auth/authorize'
import { saveTemplate, deleteTemplate } from '../../../../../server/templates-service'
import { validateDraft } from '../../../../../lib/template-builder'
import { publishConfigInvalidation } from '../../../../../server/config-publisher'

export async function saveTemplateAction(_prev: unknown, fd: FormData): Promise<{ error?: string; ok?: boolean }> {
  const actor = await requireUser()
  const paddockId = String(fd.get('paddockId') ?? '')
  try {
    requireCapability(actor, 'resource.write')
    const draft = JSON.parse(String(fd.get('draft') ?? '{}'))
    await saveTemplate(getDb(), actor, { paddockId, draft })
    revalidatePath(`/paddocks/${paddockId}/templates`)
    await publishConfigInvalidation('template.save')
    return { ok: true }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed to save template' }
  }
}

export async function deleteTemplateAction(_prev: unknown, fd: FormData): Promise<{ error?: string; ok?: boolean }> {
  const actor = await requireUser()
  const paddockId = String(fd.get('paddockId') ?? '')
  const templateId = String(fd.get('templateId') ?? '')
  try {
    requireCapability(actor, 'resource.write')
    await deleteTemplate(getDb(), actor, { paddockId, templateId })
    revalidatePath(`/paddocks/${paddockId}/templates`)
    await publishConfigInvalidation('template.delete')
    return { ok: true }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed to delete template' }
  }
}

/** Validate-only: prove the draft builds + reconstructs without persisting. */
export async function dryRunTemplateAction(draft: unknown): Promise<{ ok: boolean; reason?: string }> {
  const actor = await requireUser()
  requireCapability(actor, 'read')
  const r = validateDraft(draft)
  return r.ok ? { ok: true } : { ok: false, reason: r.reason }
}
