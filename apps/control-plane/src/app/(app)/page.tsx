import Link from 'next/link'
import { periodBucket } from '@metamodels/schema'
import { getDb } from '../../server/db'
import { requireUser } from '../../server/guard'
import { listFlocks } from '../../server/flocks-service'
import { listPaddocks } from '../../server/paddocks-service'
import { listKeys } from '../../server/keys-service'
import { topKeys, sumDimSince } from '../../server/usage-service'
import { listAudit } from '../../server/audit-service'
import { PageHeader } from '../../components/page-header'
import { StatTile } from '../../components/ui/stat-tile'
import { DataTable } from '../../components/ui/data-table'
import { BreedChip } from '../../components/ui/breed-chip'
import { StatusPill } from '../../components/ui/status-pill'
import { AuditRowItem } from '../../components/ui/audit-row'

const DAY_MS = 24 * 60 * 60 * 1000

export default async function DashboardPage() {
  const actor = await requireUser()
  const db = getDb()
  const now = Date.now()
  const since24h = periodBucket(now - DAY_MS)

  const [flocks, paddocks, keys, top, tokensIn24h, tokensOut24h, recent] = await Promise.all([
    listFlocks(db, actor),
    listPaddocks(db, actor),
    listKeys(db, actor),
    topKeys(db, actor, { dim: 'tokens_out', startBucket: since24h, endBucket: periodBucket(now), limit: 5 }),
    sumDimSince(db, actor, 'tokens_in', since24h),
    sumDimSince(db, actor, 'tokens_out', since24h),
    listAudit(db, actor, { limit: 8 }),
  ])

  const healthyFlocks = flocks.filter((f) => f.healthOk === true).length
  const activePaddocks = paddocks.filter((p) => p.status === 'active').length
  const disabledPaddocks = paddocks.length - activePaddocks
  const activeKeys = keys.filter((k) => k.status === 'active').length
  const tokens24h = tokensIn24h + tokensOut24h
  const topMax = Math.max(1, ...top.map((t) => t.value))

  return (
    <div>
      <PageHeader title="Dashboard" subtitle={`Signed in as ${actor.email}`} />

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Flock health" value={`${healthyFlocks}/${flocks.length}`} sub={flocks.length ? 'healthy servers' : 'no flocks yet'} />
        <StatTile label="Active paddocks" value={activePaddocks} sub={disabledPaddocks ? `${disabledPaddocks} disabled` : 'all active'} />
        <StatTile label="API keys" value={activeKeys} sub={`${keys.length} total`} />
        <StatTile label="Tokens · 24h" value={tokens24h.toLocaleString()} sub="tokens_in + tokens_out" />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-[var(--radius-control)] border border-[var(--color-border)] p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <span className="text-sm font-medium text-[var(--color-text)]">Flocks</span>
            <Link href="/flocks" className="text-xs text-[var(--color-primary)] hover:underline">View all →</Link>
          </div>
          <DataTable headers={['Name', 'Breed', 'Base URL', 'Health']}>
            {flocks.map((f) => (
              <tr key={f.id} className="border-b border-[var(--color-divider)]">
                <td className="px-3 py-2 text-[var(--color-text)]">{f.name}</td>
                <td className="px-3 py-2"><BreedChip breed={f.breed} /></td>
                <td className="px-3 py-2 font-mono text-xs text-[var(--color-muted)]">{f.baseUrl}</td>
                <td className="px-3 py-2"><StatusPill ok={f.healthOk} /></td>
              </tr>
            ))}
            {flocks.length === 0 && (
              <tr><td colSpan={4} className="px-3 py-6 text-center text-[var(--color-muted)]">No flocks connected.</td></tr>
            )}
          </DataTable>

          <div className="mt-4">
            <div className="mb-2 text-sm font-medium text-[var(--color-text)]">Top keys · 24h</div>
            {top.length === 0 && <div className="text-xs text-[var(--color-muted)]">No usage in the last 24h.</div>}
            {top.map((t) => (
              <div key={t.keyId} className="flex items-center gap-3 py-1">
                <span className="w-40 truncate font-mono text-xs text-[var(--color-muted)]">{t.keyPrefix}…</span>
                <span className="flex-1 text-xs text-[var(--color-text)]">{t.keyName}</span>
                <span className="w-20 text-right font-mono text-xs text-[var(--color-text)]">{t.value.toLocaleString()}</span>
                <span className="h-2 w-24 overflow-hidden rounded-full bg-[var(--color-panel-2)]">
                  <span className="block h-full bg-[var(--color-primary)]" style={{ width: `${(t.value / topMax) * 100}%` }} />
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-[var(--radius-control)] border border-[var(--color-border)] p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <span className="text-sm font-medium text-[var(--color-text)]">Recent activity</span>
            <Link href="/audit" className="text-xs text-[var(--color-primary)] hover:underline">audit →</Link>
          </div>
          {recent.length === 0 && <div className="text-xs text-[var(--color-muted)]">No activity yet.</div>}
          {recent.map((r) => (
            <AuditRowItem key={r.id} row={{
              id: r.id, createdAtISO: r.createdAt.toISOString(), actor: r.actor,
              action: r.action, target: r.target, detail: r.detail,
            }} />
          ))}
        </div>
      </div>
    </div>
  )
}
