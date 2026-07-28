import { getDb } from '../../../server/db'
import { requireUser } from '../../../server/guard'
import { authorize } from '../../../auth/authorize'
import { listKeys } from '../../../server/keys-service'
import { listPaddocks } from '../../../server/paddocks-service'
import { KeysClient } from './keys-client'

export default async function KeysPage() {
  const actor = await requireUser()
  const db = getDb()
  const [keys, paddocks] = await Promise.all([listKeys(db, actor), listPaddocks(db, actor)])
  const canWrite = authorize(actor, 'resource.write')
  return (
    <KeysClient
      canWrite={canWrite}
      paddocks={paddocks.map((p) => ({ id: p.id, name: p.name, slug: p.slug }))}
      keys={keys.map((k) => ({
        id: k.id, name: k.name, prefix: k.prefix, status: k.status,
        expiresAt: k.expiresAt ? k.expiresAt.toISOString() : null,
        paddockSlugs: k.paddockSlugs,
      }))}
    />
  )
}
