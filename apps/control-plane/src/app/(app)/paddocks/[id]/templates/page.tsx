import { notFound } from 'next/navigation'
import { getDb } from '../../../../../server/db'
import { requireUser } from '../../../../../server/guard'
import { authorize } from '../../../../../auth/authorize'
import { listPaddocks } from '../../../../../server/paddocks-service'
import { listFlocks } from '../../../../../server/flocks-service'
import { listTemplates } from '../../../../../server/templates-service'
import { TemplatesClient } from './templates-client'

export default async function TemplatesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const actor = await requireUser()
  const db = getDb()
  const paddocks = await listPaddocks(db, actor)
  const paddock = paddocks.find((p) => p.id === id)
  if (!paddock) notFound()
  const flocks = await listFlocks(db, actor)
  const breed = flocks.find((f) => f.id === paddock.flockId)?.breed ?? 'ollama'
  if (breed !== 'comfyui') notFound() // templates are a comfyui-only screen

  const templates = await listTemplates(db, actor, id)

  return (
    <TemplatesClient
      canWrite={authorize(actor, 'resource.write')}
      paddock={{ id: paddock.id, name: paddock.name, slug: paddock.slug }}
      templates={templates}
    />
  )
}
