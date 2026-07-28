import { notFound } from 'next/navigation'
import { getDb } from '../../../../../server/db'
import { requireUser } from '../../../../../server/guard'
import { authorize } from '../../../../../auth/authorize'
import { listPaddocks } from '../../../../../server/paddocks-service'
import { listFlocks } from '../../../../../server/flocks-service'
import { getFence } from '../../../../../server/fences-service'
import { computeBlastRadius } from '../../../../../server/blast-radius'
import { FenceClient } from './fence-client'

export default async function FencePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const actor = await requireUser()
  const db = getDb()
  const paddocks = await listPaddocks(db, actor)
  const paddock = paddocks.find((p) => p.id === id)
  if (!paddock) notFound()
  const flocks = await listFlocks(db, actor)
  const breed = flocks.find((f) => f.id === paddock.flockId)?.breed ?? 'ollama'
  const fence = await getFence(db, actor, id)
  const br = computeBlastRadius(breed, fence?.constraintJson ?? {}, fence?.rateLimit ?? null, fence?.quota ?? null)

  return (
    <FenceClient
      canWrite={authorize(actor, 'resource.write')}
      paddock={{ id: paddock.id, name: paddock.name, slug: paddock.slug, breed }}
      constraintJson={(fence?.constraintJson ?? null) as unknown}
      rateLimit={(fence?.rateLimit ?? null) as { windowSec: number; max: number } | null}
      quota={(fence?.quota ?? null) as Array<{ dim: string; max: number; period: string }> | null}
      blastRadius={br}
    />
  )
}
