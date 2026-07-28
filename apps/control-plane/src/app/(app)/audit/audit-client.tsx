'use client'
import { useRouter } from 'next/navigation'
import { PageHeader } from '../../../components/page-header'
import { Select } from '../../../components/ui/select'
import { AuditRowItem, type AuditRowData } from '../../../components/ui/audit-row'

/** Group label for a day: Today / Yesterday / weekday+date, from the row's UTC date. */
function dayLabel(iso: string, now: Date): string {
  const d = new Date(iso)
  const today = now.toISOString().slice(0, 10)
  const y = new Date(now.getTime() - 86400000).toISOString().slice(0, 10)
  const day = iso.slice(0, 10)
  if (day === today) return 'Today'
  if (day === y) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

export function AuditClient(props: {
  action: string; actor: string
  options: { actions: string[]; actors: string[] }
  rows: AuditRowData[]
}) {
  const router = useRouter()
  const now = new Date()

  function apply(next: Partial<{ action: string; actor: string }>) {
    const params = new URLSearchParams()
    const action = next.action ?? props.action
    const actor = next.actor ?? props.actor
    if (action) params.set('action', action)
    if (actor) params.set('actor', actor)
    const qs = params.toString()
    router.push(qs ? `/audit?${qs}` : '/audit')
  }

  // Group consecutive rows (already newest-first) by day label.
  const groups: { label: string; rows: AuditRowData[] }[] = []
  for (const row of props.rows) {
    const label = dayLabel(row.createdAtISO, now)
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.rows.push(row)
    else groups.push({ label, rows: [row] })
  }

  return (
    <div>
      <PageHeader
        title="Audit log"
        actions={
          <div className="flex gap-2">
            <Select aria-label="Action" value={props.action} onChange={(e) => apply({ action: e.target.value })}>
              <option value="">All actions</option>
              {props.options.actions.map((a) => <option key={a} value={a}>{a}</option>)}
            </Select>
            <Select aria-label="Actor" value={props.actor} onChange={(e) => apply({ actor: e.target.value })}>
              <option value="">All actors</option>
              {props.options.actors.map((a) => <option key={a} value={a}>{a}</option>)}
            </Select>
          </div>
        }
      />

      {groups.map((g) => (
        <div key={g.label} className="mb-4">
          <div className="mb-1 px-3 text-xs uppercase tracking-wide text-[var(--color-faint)]">{g.label}</div>
          {g.rows.map((row) => <AuditRowItem key={row.id} row={row} />)}
        </div>
      ))}
      {props.rows.length === 0 && (
        <div className="px-3 py-8 text-center text-[var(--color-muted)]">No audit events match these filters.</div>
      )}
    </div>
  )
}
