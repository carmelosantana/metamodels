'use client'
import { useRouter } from 'next/navigation'
import { METER_DIMS, type MeterDim } from '@metamodels/schema/config'
import { PageHeader } from '../../../components/page-header'
import { DataTable } from '../../../components/ui/data-table'
import { Select } from '../../../components/ui/select'
import { BarChart } from '../../../components/ui/bar-chart'
import type { UsageRange } from '../../../lib/usage-range'
import type { UsageMatrixRow } from '../../../server/usage-service'

interface Opt { id: string; label: string }

export function UsageClient(props: {
  range: UsageRange; keyId: string; paddockId: string
  bars: { label: string; value: number }[]; total: number
  rows: UsageMatrixRow[]
  keys: { id: string; name: string }[]
  paddocks: { id: string; slug: string }[]
}) {
  const router = useRouter()

  function apply(next: Partial<{ key: string; paddock: string; range: string }>) {
    const params = new URLSearchParams()
    const key = next.key ?? props.keyId
    const paddock = next.paddock ?? props.paddockId
    const range = next.range ?? props.range
    if (key) params.set('key', key)
    if (paddock) params.set('paddock', paddock)
    params.set('range', range)
    router.push(`/usage?${params.toString()}`)
  }

  const num = (n: number) => (n === 0 ? '—' : n.toLocaleString())

  return (
    <div>
      <PageHeader
        title="Usage"
        actions={
          <div className="flex gap-2">
            <Select aria-label="Key" value={props.keyId} onChange={(e) => apply({ key: e.target.value })}>
              <option value="">All keys</option>
              {props.keys.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
            </Select>
            <Select aria-label="Paddock" value={props.paddockId} onChange={(e) => apply({ paddock: e.target.value })}>
              <option value="">All paddocks</option>
              {props.paddocks.map((p) => <option key={p.id} value={p.id}>/p/{p.slug}</option>)}
            </Select>
            <Select aria-label="Range" value={props.range} onChange={(e) => apply({ range: e.target.value })}>
              <option value="24h">Last 24h</option>
              <option value="7d">Last 7d</option>
              <option value="30d">Last 30d</option>
            </Select>
          </div>
        }
      />

      <div className="mb-6 rounded-[var(--radius-control)] border border-[var(--color-border)] p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <span className="text-sm text-[var(--color-text)]">tokens_out · last {props.range}</span>
          <span className="font-mono text-sm text-[var(--color-primary)]">{props.total.toLocaleString()} total</span>
        </div>
        <BarChart bars={props.bars} />
      </div>

      <DataTable headers={['Key', 'Paddock', ...METER_DIMS.map((d) => d as string)]}>
        {props.rows.map((r) => (
          <tr key={`${r.keyId}|${r.paddockId}`} className="border-b border-[var(--color-divider)]">
            <td className="px-3 py-2 text-[var(--color-text)]">{r.keyName}</td>
            <td className="px-3 py-2 font-mono text-xs text-[var(--color-muted)]">/p/{r.paddockSlug}</td>
            {METER_DIMS.map((d) => (
              <td key={d} className="px-3 py-2 text-right font-mono text-xs text-[var(--color-text)]">{num(r.dims[d as MeterDim])}</td>
            ))}
          </tr>
        ))}
        {props.rows.length === 0 && (
          <tr><td colSpan={2 + METER_DIMS.length} className="px-3 py-8 text-center text-[var(--color-muted)]">No usage recorded in this range.</td></tr>
        )}
      </DataTable>
    </div>
  )
}
