import { cn } from './cn'
import type { ButtonHTMLAttributes } from 'react'

type Variant = 'primary' | 'ghost' | 'danger'

export function Button({
  variant = 'primary', className, ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const styles: Record<Variant, string> = {
    primary: 'bg-[var(--color-primary)] text-[var(--color-on-primary)] hover:opacity-90',
    ghost: 'bg-transparent text-[var(--color-text)] border border-[var(--color-border)] hover:bg-[var(--color-panel-2)]',
    danger: 'bg-transparent text-[var(--color-danger)] border border-[var(--color-danger)] hover:bg-[var(--color-danger)]/10',
  }
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center rounded-[var(--radius-control)] px-3 py-2 text-sm font-medium transition disabled:opacity-50',
        styles[variant], className,
      )}
      {...props}
    />
  )
}
