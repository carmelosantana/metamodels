import { AcceptInviteForm } from './accept-invite-form'

export default async function AcceptInvitePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams
  if (!token) {
    return <main className="p-8 text-sm text-[var(--color-muted)]">This invite link is missing its token.</main>
  }
  return <AcceptInviteForm token={token} />
}
