'use client'
import { useState } from 'react'
import { PageHeader } from '../../../components/page-header'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { Label } from '../../../components/ui/label'
import { StatusPill } from '../../../components/ui/status-pill'
import { activateLicenseAction, deactivateLicenseAction, revalidateLicenseAction } from './actions'

const STOREFRONT_URL = 'https://lemonsqueezy.com'

interface Usage { used: number; limit: number; free: number }
interface EntitlementItem {
  status: string; seats: number; tier: string | null; last4: string
  lastValidatedAt: string | null; graceUntil: string | null
}

function fmt(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString()
}

export function SettingsClient({ usage, entitlement }: { usage: Usage; entitlement: EntitlementItem | null }) {
  const [error, setError] = useState<string | undefined>()

  async function onActivate(fd: FormData) {
    const r = await activateLicenseAction(null, fd)
    if (r.error) { setError(r.error); return }
    setError(undefined)
  }

  if (entitlement === null) {
    return (
      <div>
        <PageHeader
          title="License"
          subtitle="Activate a license to unlock additional seats and premium tiers."
        />

        <div className="mb-6 max-w-2xl rounded-[var(--radius-control)] border border-[var(--color-divider)] bg-[var(--color-panel-2)] p-4 text-sm text-[var(--color-muted)]">
          <p className="mb-2 text-[var(--color-text)]">
            This instance is running on the free tier ({usage.used} of {usage.limit} seats in use).
          </p>
          <p>
            Purchase a license to add teammates and lift usage limits. Enter your license key below to
            activate this instance. Need a key?{' '}
            <a
              href={STOREFRONT_URL}
              target="_blank"
              rel="noreferrer"
              className="text-[var(--color-primary)] underline"
            >
              Visit the store
            </a>
            .
          </p>
        </div>

        <form action={onActivate} className="flex max-w-md flex-col gap-4">
          <div>
            <Label htmlFor="licenseKey">License key</Label>
            <Input id="licenseKey" name="licenseKey" required placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
          </div>
          <div>
            <Label htmlFor="instanceName">Instance name (optional)</Label>
            <Input id="instanceName" name="instanceName" placeholder="metamodels" />
          </div>
          {error && <div className="text-sm text-[var(--color-danger)]">{error}</div>}
          <div>
            <Button type="submit">Activate license</Button>
          </div>
        </form>
      </div>
    )
  }

  const ok = entitlement.status === 'active'

  return (
    <div>
      <PageHeader
        title="License"
        subtitle="Manage this instance's license and seats."
      />

      <div className="max-w-2xl overflow-hidden rounded-[var(--radius-control)] border border-[var(--color-divider)] bg-[var(--color-panel-2)]">
        <dl className="divide-y divide-[var(--color-divider)]">
          <div className="flex items-center justify-between px-4 py-3">
            <dt className="text-sm text-[var(--color-muted)]">Status</dt>
            <dd><StatusPill ok={ok} labels={['Active', entitlement.status]} /></dd>
          </div>
          <div className="flex items-center justify-between px-4 py-3">
            <dt className="text-sm text-[var(--color-muted)]">Tier</dt>
            <dd className="text-sm text-[var(--color-text)]">{entitlement.tier ?? '—'}</dd>
          </div>
          <div className="flex items-center justify-between px-4 py-3">
            <dt className="text-sm text-[var(--color-muted)]">Seats</dt>
            <dd className="text-sm text-[var(--color-text)]">
              {usage.used} / {usage.limit} used
              <span className="ml-2 text-[var(--color-muted)]">({usage.free} free)</span>
            </dd>
          </div>
          <div className="flex items-center justify-between px-4 py-3">
            <dt className="text-sm text-[var(--color-muted)]">License key</dt>
            <dd className="font-mono text-sm text-[var(--color-text)]">•••• {entitlement.last4}</dd>
          </div>
          <div className="flex items-center justify-between px-4 py-3">
            <dt className="text-sm text-[var(--color-muted)]">Last validated</dt>
            <dd className="text-sm text-[var(--color-text)]">{fmt(entitlement.lastValidatedAt)}</dd>
          </div>
          <div className="flex items-center justify-between px-4 py-3">
            <dt className="text-sm text-[var(--color-muted)]">Grace until</dt>
            <dd className="text-sm text-[var(--color-text)]">{fmt(entitlement.graceUntil)}</dd>
          </div>
        </dl>
      </div>

      <div className="mt-4 flex max-w-2xl gap-2">
        <form action={async () => { await revalidateLicenseAction() }}>
          <Button variant="ghost" type="submit">Re-validate</Button>
        </form>
        <form action={async () => { await deactivateLicenseAction() }}>
          <Button variant="danger" type="submit">Deactivate</Button>
        </form>
      </div>
    </div>
  )
}
