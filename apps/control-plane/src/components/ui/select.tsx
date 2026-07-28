import { cn } from './cn'
import type { SelectHTMLAttributes } from 'react'

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'w-full rounded-[var(--radius-control)] border border-[var(--color-input-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm text-[var(--color-text)] focus:border-[var(--color-primary)] focus:outline-none',
        className,
      )}
      {...props}
    />
  )
}
