import { eq } from 'drizzle-orm'
import { comfyuiConstraint, type WorkflowTemplate } from '@metamodels/connectors'
import { fence } from '@metamodels/schema'
import type { Db } from './db'
import { requireCapability, type Actor } from '../auth/authorize'
import { writeAudit } from './audit'
import { NotFoundError, paddockBreedInOrg } from './fences-service'
import { validateDraft } from '../lib/template-builder'

/** Load the current templates for an org-scoped comfyui paddock. Throws NotFoundError otherwise. */
async function currentTemplates(tx: Db, actor: Actor, paddockId: string): Promise<WorkflowTemplate[]> {
  const breed = await paddockBreedInOrg(tx, actor, paddockId)
  if (breed !== 'comfyui') throw new NotFoundError(`comfyui paddock ${paddockId}`)
  const [row] = await tx.select().from(fence).where(eq(fence.paddockId, paddockId)).limit(1)
  if (!row) return []
  return comfyuiConstraint.parse(row.constraintJson).templates
}

/** Persist `templates` into the paddock's fence, writing ONLY constraint_json (rate/quota preserved). */
async function writeTemplates(tx: Db, actor: Actor, paddockId: string, templates: WorkflowTemplate[]): Promise<void> {
  const constraintJson = comfyuiConstraint.parse({ templates })
  await tx
    .insert(fence)
    .values({
      orgId: actor.orgId, paddockId,
      constraintJson: constraintJson as never, rateLimit: null as never, quota: null as never,
    })
    .onConflictDoUpdate({ target: fence.paddockId, set: { constraintJson: constraintJson as never } })
}

export async function listTemplates(db: Db, actor: Actor, paddockId: string): Promise<WorkflowTemplate[]> {
  requireCapability(actor, 'read')
  return currentTemplates(db, actor, paddockId)
}

export async function saveTemplate(
  db: Db, actor: Actor, input: { paddockId: string; draft: unknown },
): Promise<WorkflowTemplate[]> {
  requireCapability(actor, 'resource.write')
  const validated = validateDraft(input.draft)
  if (!validated.ok) throw new Error(validated.reason)
  const tpl = validated.value

  return db.transaction(async (tx) => {
    const existing = await currentTemplates(tx, actor, input.paddockId)
    const next = existing.some((t) => t.id === tpl.id)
      ? existing.map((t) => (t.id === tpl.id ? tpl : t))
      : [...existing, tpl]
    await writeTemplates(tx, actor, input.paddockId, next)
    await writeAudit(tx, {
      orgId: actor.orgId, actor: actor.email, action: 'template.save',
      target: `paddock:${input.paddockId}`, detail: { templateId: tpl.id },
    })
    return next
  })
}

export async function deleteTemplate(
  db: Db, actor: Actor, input: { paddockId: string; templateId: string },
): Promise<WorkflowTemplate[]> {
  requireCapability(actor, 'resource.write')
  return db.transaction(async (tx) => {
    const existing = await currentTemplates(tx, actor, input.paddockId)
    const next = existing.filter((t) => t.id !== input.templateId)
    await writeTemplates(tx, actor, input.paddockId, next)
    await writeAudit(tx, {
      orgId: actor.orgId, actor: actor.email, action: 'template.delete',
      target: `paddock:${input.paddockId}`, detail: { templateId: input.templateId },
    })
    return next
  })
}
