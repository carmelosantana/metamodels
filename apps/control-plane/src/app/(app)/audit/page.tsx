import { getDb } from '../../../server/db'
import { requireUser } from '../../../server/guard'
import { listAudit, auditFilterOptions } from '../../../server/audit-service'
import { AuditClient } from './audit-client'

export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const actor = await requireUser()
  const db = getDb()

  const action = typeof sp.action === 'string' && sp.action ? sp.action : undefined
  const auditActor = typeof sp.actor === 'string' && sp.actor ? sp.actor : undefined

  const [rows, options] = await Promise.all([
    listAudit(db, actor, { action, auditActor, limit: 200 }),
    auditFilterOptions(db, actor),
  ])

  return (
    <AuditClient
      action={action ?? ''}
      actor={auditActor ?? ''}
      options={options}
      rows={rows.map((r) => ({
        id: r.id, createdAtISO: r.createdAt.toISOString(), actor: r.actor,
        action: r.action, target: r.target, detail: r.detail,
      }))}
    />
  )
}
