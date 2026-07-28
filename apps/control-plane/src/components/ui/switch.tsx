'use client'
import { cn } from './cn'

export function Switch({ checked, onChange, name }: { checked: boolean; onChange: (v: boolean) => void; name?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 items-center rounded-full transition',
        checked ? 'bg-[var(--color-primary)]' : 'bg-[var(--color-border)]',
      )}
    >
      <span className={cn('inline-block h-4 w-4 transform rounded-full bg-[var(--color-bg)] transition', checked ? 'translate-x-4' : 'translate-x-1')} />
      {name && <input type="hidden" name={name} value={checked ? 'true' : 'false'} />}
    </button>
  )
}
