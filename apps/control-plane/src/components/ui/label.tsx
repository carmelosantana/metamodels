import { cn } from './cn'
import type { LabelHTMLAttributes } from 'react'

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('mb-1 block text-xs font-medium text-[var(--color-muted)]', className)} {...props} />
}
