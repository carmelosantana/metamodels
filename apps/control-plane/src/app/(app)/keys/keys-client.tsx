'use client'
import { useState } from 'react'
import { PageHeader } from '../../../components/page-header'
import { DataTable } from '../../../components/ui/data-table'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { Label } from '../../../components/ui/label'
import { Drawer } from '../../../components/ui/drawer'
import { StatusPill } from '../../../components/ui/status-pill'
import { createKeyAction, revokeKeyAction } from './actions'

interface PaddockOpt { id: string; name: string; slug: string }
interface KeyRow {
  id: string; name: string; prefix: string; status: string
  expiresAt: string | null; paddockSlugs: string[]
}

export function KeysClient(
  { keys, paddocks, canWrite }: { keys: KeyRow[]; paddocks: PaddockOpt[]; canWrite: boolean },
) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [secret, setSecret] = useState<{ plaintext: string; prefix: string } | null>(null)

  async function onCreate(fd: FormData) {
    const r = await createKeyAction(null, fd)
    if (r.error) { setError(r.error); return }
    setError(undefined)
    setOpen(false)
    if (r.plaintext && r.prefix) setSecret({ plaintext: r.plaintext, prefix: r.prefix })
  }

  return (
    <div>
      <PageHeader
        title="API Keys"
        subtitle="Mint keys scoped to paddocks. A key's secret is shown once, at creation."
        actions={canWrite && <Button onClick={() => { setError(undefined); setOpen(true) }}>Mint a key</Button>}
      />

      {secret && (
        <div className="mb-4 rounded-[var(--radius-control)] border border-[var(--color-primary)] bg-[var(--color-panel-2)] p-4">
          <div className="mb-1 text-sm font-semibold text-[var(--color-primary)]">
            Copy this key now — it will not be shown again.
          </div>
          <code className="block break-all font-mono text-sm text-[var(--color-text)]">{secret.plaintext}</code>
          <div className="mt-2">
            <Button variant="ghost" onClick={() => setSecret(null)}>Done</Button>
          </div>
        </div>
      )}

      <DataTable headers={['Name', 'Prefix', 'Paddocks', 'Status', 'Expires', '']}>
        {keys.map((k) => (
          <tr key={k.id} className="border-b border-[var(--color-divider)]">
            <td className="px-3 py-2 text-[var(--color-text)]">{k.name}</td>
            <td className="px-3 py-2 font-mono text-xs text-[var(--color-muted)]">{k.prefix}…</td>
            <td className="px-3 py-2 text-xs text-[var(--color-muted)]">{k.paddockSlugs.join(', ') || '—'}</td>
            <td className="px-3 py-2"><StatusPill ok={k.status === 'active'} /></td>
            <td className="px-3 py-2 text-xs text-[var(--color-muted)]">{k.expiresAt ? k.expiresAt.slice(0, 10) : '—'}</td>
            <td className="px-3 py-2 text-right">
              {canWrite && k.status === 'active' && (
                <form action={async (fd) => { await revokeKeyAction(fd) }} className="inline">
                  <input type="hidden" name="id" value={k.id} />
                  <Button variant="danger" type="submit">Revoke</Button>
                </form>
              )}
            </td>
          </tr>
        ))}
        {keys.length === 0 && (
          <tr><td colSpan={6} className="px-3 py-8 text-center text-[var(--color-muted)]">No keys yet. Mint one to give a consumer access.</td></tr>
        )}
      </DataTable>

      <Drawer open={open} onClose={() => setOpen(false)} title="Mint a key">
        <form action={onCreate} className="flex flex-col gap-4">
          <div><Label htmlFor="name">Name</Label><Input id="name" name="name" required /></div>

          <div>
            <Label htmlFor="paddockIds">Scope to paddocks</Label>
            {paddocks.length === 0 ? (
              <div className="text-sm text-[var(--color-muted)]">No paddocks yet — publish one first.</div>
            ) : (
              <select
                id="paddockIds" name="paddockIds" multiple required
                className="w-full rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-panel)] p-2 text-sm"
              >
                {paddocks.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.slug})</option>)}
              </select>
            )}
          </div>

          <div><Label htmlFor="expiresAt">Expires (optional)</Label><Input id="expiresAt" name="expiresAt" type="date" /></div>

          <fieldset className="rounded-[var(--radius-control)] border border-[var(--color-border)] p-3">
            <legend className="px-1 text-xs text-[var(--color-muted)]">Per-key rate override (optional)</legend>
            <div className="flex gap-2">
              <div className="flex-1"><Label htmlFor="rateMax">Max requests</Label><Input id="rateMax" name="rateMax" type="number" min="0" /></div>
              <div className="flex-1"><Label htmlFor="rateWindowSec">Per (seconds)</Label><Input id="rateWindowSec" name="rateWindowSec" type="number" min="1" /></div>
            </div>
          </fieldset>

          {error && <div className="text-sm text-[var(--color-danger)]">{error}</div>}
          <div className="flex gap-2">
            <Button type="submit" disabled={paddocks.length === 0}>Create key</Button>
          </div>
        </form>
      </Drawer>
    </div>
  )
}
