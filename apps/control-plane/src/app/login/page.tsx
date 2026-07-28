'use client'
import { useActionState } from 'react'
import { login } from './actions'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Label } from '../../components/ui/label'

export default function LoginPage() {
  const [state, formAction, pending] = useActionState(login, {})
  return (
    <div className="flex min-h-screen items-center justify-center">
      <form action={formAction} className="w-[360px] rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-panel)] p-6">
        <div className="mb-6 font-mono text-lg font-semibold text-[var(--color-primary)]">MetaModels</div>
        <div className="mb-4">
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="username" required />
        </div>
        <div className="mb-4">
          <Label htmlFor="password">Password</Label>
          <Input id="password" name="password" type="password" autoComplete="current-password" required />
        </div>
        {state?.error && <p className="mb-4 text-sm text-[var(--color-danger)]">{state.error}</p>}
        <Button type="submit" className="w-full" disabled={pending}>{pending ? 'Signing in…' : 'Sign in'}</Button>
      </form>
    </div>
  )
}
