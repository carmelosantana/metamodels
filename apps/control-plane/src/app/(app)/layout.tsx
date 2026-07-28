import type { ReactNode } from 'react'
import { requireUser } from '../../server/guard'
import { AppSidebar } from '../../components/app-sidebar'
import { logout } from '../login/actions'
import { Button } from '../../components/ui/button'

export default async function AppLayout({ children }: { children: ReactNode }) {
  const actor = await requireUser()
  return (
    <div className="flex min-h-screen">
      <AppSidebar role={actor.role} email={actor.email} />
      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-[var(--color-border)] px-8 py-3">
          <div className="text-sm text-[var(--color-muted)]">Operator console</div>
          <form action={logout}><Button variant="ghost" type="submit">Sign out</Button></form>
        </header>
        <main className="flex-1 p-8">{children}</main>
      </div>
    </div>
  )
}
