'use client'
import { useState } from 'react'
import { cn } from './cn'

export interface AuditRowData {
  id: string
  createdAtISO: string
  actor: string
  action: string
  target: string
  detail: unknown
}

/** Colour the status dot: destructive verbs red, health amber, else primary. */
function dotClass(action: string): string {
  if (/revoke|delete|disable/.test(action)) return 'bg-[var(--color-danger)]'
  if (/health/.test(action)) return 'bg-[var(--color-comfyui)]'
  return 'bg-[var(--color-primary)]'
}

/** verb from a dotted action id, e.g. 'key.revoke' → 'revoke'. */
function verb(action: string): string {
  const i = action.indexOf('.')
  return i >= 0 ? action.slice(i + 1) : action
}

export function AuditRowItem({ row }: { row: AuditRowData }) {
  const [open, setOpen] = useState(false)
  const time = row.createdAtISO.slice(11, 16) // HH:MM (UTC)
  const hasDetail = row.detail != null && typeof row.detail === 'object'

  return (
    <div className="border-b border-[var(--color-divider)]">
      <button
        type="button"
        onClick={() => hasDetail && setOpen((v) => !v)}
        className="flex w-full items-center gap-4 px-3 py-2 text-left"
      >
        <span className="w-12 font-mono text-xs text-[var(--color-muted)]">{time}</span>
        <span className={cn('h-2 w-2 shrink-0 rounded-full', dotClass(row.action))} />
        <span className="w-24 font-mono text-xs text-[var(--color-text)]">{verb(row.action)}</span>
        <span className="flex-1 text-sm text-[var(--color-muted)]">{row.target}</span>
        <span className="text-xs text-[var(--color-muted)]">{row.actor}</span>
        {hasDetail && <span className="text-xs text-[var(--color-faint)]">{open ? '▾' : '▸'}</span>}
      </button>
      {open && hasDetail && (
        <pre className="mx-3 mb-2 overflow-x-auto rounded-[var(--radius-control)] bg-[var(--color-panel-2)] p-3 font-mono text-xs text-[var(--color-muted)]">
          {JSON.stringify(row.detail, null, 2)}
        </pre>
      )}
    </div>
  )
}
