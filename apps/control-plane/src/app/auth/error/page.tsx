const MESSAGES: Record<string, string> = {
  unavailable: 'The sign-in service is not reachable. Check that the auth service is running.',
  access_denied: 'Sign-in was cancelled or refused.',
  provider_error: 'The sign-in service reported an error.',
  state_mismatch: 'This sign-in attempt expired, or was started in another tab.',
  issuer_mismatch: 'The sign-in response came from an unexpected issuer.',
  missing_code: 'The sign-in response was incomplete.',
  token_exchange_failed: 'The console could not complete sign-in with the auth service.',
  account_unavailable: 'This account is deactivated or no longer exists.',
}

export default async function SignInErrorPage({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  const { reason } = await searchParams
  const message = reason && Object.hasOwn(MESSAGES, reason) ? MESSAGES[reason] : 'Sign-in could not be completed.'
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-[360px] rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-panel)] p-6">
        <div className="mb-6 font-mono text-lg font-semibold text-[var(--color-primary)]">MetaModels</div>
        <p className="mb-4 text-sm">{message}</p>
        {/* A plain anchor, not <Link>: /login is a route handler that redirects off-origin. */}
        <a href="/login" className="text-sm text-[var(--color-primary)] hover:underline">Try again</a>
      </div>
    </div>
  )
}
