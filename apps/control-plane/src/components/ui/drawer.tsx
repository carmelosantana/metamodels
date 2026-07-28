'use client'
import type { ReactNode } from 'react'
import { cn } from './cn'

export function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className={cn('absolute right-0 top-0 h-full w-[420px] overflow-y-auto border-l border-[var(--color-border)] bg-[var(--color-panel)] p-6')}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-[var(--color-text)]">{title}</h2>
          <button onClick={onClose} className="text-[var(--color-muted)] hover:text-[var(--color-text)]">✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}
