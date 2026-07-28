import { cn } from './cn'

export function StatusPill({ ok, labels = ['Healthy', 'Down'] }: { ok: boolean | null; labels?: [string, string] }) {
  const text = ok === null ? 'Unknown' : ok ? labels[0] : labels[1]
  return (
    <span className={cn(
      'inline-flex items-center gap-1 rounded-[var(--radius-chip)] px-2 py-0.5 text-xs font-medium',
      ok === null ? 'text-[var(--color-muted)] bg-[var(--color-panel-2)]'
        : ok ? 'text-[var(--color-primary)] bg-[var(--color-primary)]/10'
          : 'text-[var(--color-danger)] bg-[var(--color-danger)]/10',
    )}>
      {text}
    </span>
  )
}
