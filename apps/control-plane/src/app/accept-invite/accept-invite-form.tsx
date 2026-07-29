'use client'
import { useActionState } from 'react'
import { acceptInviteAction } from './actions'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'

export function AcceptInviteForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState(acceptInviteAction, {})
  return (
    <div className="flex min-h-screen items-center justify-center">
      <form action={formAction} className="w-[360px] rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-panel)] p-6">
        <div className="mb-6 font-mono text-lg font-semibold text-[var(--color-primary)]">Accept your invite</div>
        <input type="hidden" name="token" value={token} />
        <div className="mb-4">
          <Label htmlFor="password">Password</Label>
          <Input id="password" name="password" type="password" autoComplete="new-password" required />
        </div>
        <div className="mb-4">
          <Label htmlFor="confirm">Confirm password</Label>
          <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
        </div>
        {state?.error && <p className="mb-4 text-sm text-[var(--color-danger)]">{state.error}</p>}
        <Button type="submit" className="w-full" disabled={pending}>{pending ? 'Setting password…' : 'Set password & continue'}</Button>
      </form>
    </div>
  )
}
