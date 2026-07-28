import { getDb } from '../../../server/db'
import { requireUser } from '../../../server/guard'
import { authorize } from '../../../auth/authorize'
import { listPaddocks } from '../../../server/paddocks-service'
import { listFlocks } from '../../../server/flocks-service'
import { PaddocksClient } from './paddocks-client'

export default async function PaddocksPage() {
  const actor = await requireUser()
  const db = getDb()
  const [paddocks, flocks] = await Promise.all([listPaddocks(db, actor), listFlocks(db, actor)])
  const byFlock = new Map(flocks.map((f) => [f.id, f]))
  return (
    <PaddocksClient
      canWrite={authorize(actor, 'resource.write')}
      flocks={flocks.map((f) => ({ id: f.id, name: f.name, breed: f.breed }))}
      paddocks={paddocks.map((p) => ({
        id: p.id, name: p.name, slug: p.slug, status: p.status, theme: p.theme,
        flockName: byFlock.get(p.flockId)?.name ?? '—', breed: byFlock.get(p.flockId)?.breed ?? '—',
      }))}
    />
  )
}
