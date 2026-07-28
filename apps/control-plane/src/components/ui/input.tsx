import { cn } from './cn'
import type { InputHTMLAttributes } from 'react'

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'w-full rounded-[var(--radius-control)] border border-[var(--color-input-border)] bg-[var(--color-panel-2)] px-3 py-2 text-sm text-[var(--color-text)] placeholder:text-[var(--color-faint)] focus:border-[var(--color-primary)] focus:outline-none',
        className,
      )}
      {...props}
    />
  )
}
