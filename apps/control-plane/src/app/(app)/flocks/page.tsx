import { getDb } from '../../../server/db'
import { requireUser } from '../../../server/guard'
import { authorize } from '../../../auth/authorize'
import { listFlocks } from '../../../server/flocks-service'
import { FlocksClient } from './flocks-client'

export default async function FlocksPage() {
  const actor = await requireUser()
  const flocks = await listFlocks(getDb(), actor)
  const canWrite = authorize(actor, 'resource.write')
  return <FlocksClient flocks={flocks.map((f) => ({
    id: f.id, name: f.name, breed: f.breed, baseUrl: f.baseUrl, healthOk: f.healthOk,
  }))} canWrite={canWrite} />
}
