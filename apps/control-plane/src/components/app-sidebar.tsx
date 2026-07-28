import Link from 'next/link'
import { navItemsForRole } from '../auth/nav'
import type { Role } from '../auth/authorize'

export function AppSidebar({ role, email }: { role: Role; email: string }) {
  const items = navItemsForRole(role)
  return (
    <aside className="flex w-[228px] flex-col border-r border-[var(--color-border)] bg-[var(--color-panel)] p-4">
      <div className="mb-6 px-2 font-mono text-sm font-semibold text-[var(--color-primary)]">MetaModels</div>
      <nav className="flex flex-col gap-1">
        {items.map((i) => (
          <Link key={i.href} href={i.href} className="rounded-[var(--radius-control)] px-3 py-2 text-sm text-[var(--color-text)] hover:bg-[var(--color-panel-2)]">
            {i.label}
          </Link>
        ))}
      </nav>
      <div className="mt-auto px-2 pt-4 text-xs text-[var(--color-faint)]">
        <div className="truncate">{email}</div>
        <div className="uppercase">{role}</div>
      </div>
    </aside>
  )
}
