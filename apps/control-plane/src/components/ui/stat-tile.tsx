import type { ReactNode } from 'react'

/** Dashboard overview tile: an uppercase label, a large value, and an optional sub-line/visual. */
export function StatTile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rounded-[var(--radius-control)] border border-[var(--color-border)] p-4">
      <div className="mb-2 text-xs uppercase tracking-wide text-[var(--color-muted)]">{label}</div>
      <div className="text-3xl font-semibold text-[var(--color-text)]">{value}</div>
      {sub && <div className="mt-2 text-xs text-[var(--color-muted)]">{sub}</div>}
    </div>
  )
}
