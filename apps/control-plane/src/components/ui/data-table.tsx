import type { ReactNode } from 'react'

export function DataTable({ headers, children }: { headers: string[]; children: ReactNode }) {
  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-[var(--color-border)] text-left text-xs text-[var(--color-muted)]">
          {headers.map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  )
}
