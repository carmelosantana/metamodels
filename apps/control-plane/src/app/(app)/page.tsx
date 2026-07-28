import { requireUser } from '../../server/guard'

export default async function DashboardPage() {
  const actor = await requireUser()
  return (
    <div>
      <h1 className="text-xl font-semibold">Welcome, {actor.email}</h1>
      <p className="mt-2 text-sm text-[var(--color-muted)]">Dashboard metrics arrive in Plan 5.5. Manage your Flocks from the sidebar.</p>
    </div>
  )
}
