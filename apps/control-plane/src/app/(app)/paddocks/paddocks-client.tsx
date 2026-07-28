'use client'
import { useState } from 'react'
import Link from 'next/link'
import { PageHeader } from '../../../components/page-header'
import { DataTable } from '../../../components/ui/data-table'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { Label } from '../../../components/ui/label'
import { Select } from '../../../components/ui/select'
import { Drawer } from '../../../components/ui/drawer'
import { StatusPill } from '../../../components/ui/status-pill'
import { BreedChip } from '../../../components/ui/breed-chip'
import { cn } from '../../../components/ui/cn'
import { savePaddockAction, deletePaddockAction, togglePaddockStatusAction } from './actions'

interface FlockOpt { id: string; name: string; breed: string }
interface Row { id: string; name: string; slug: string; status: string; theme: string; flockName: string; breed: string }

export function PaddocksClient({ paddocks, flocks, canWrite }: { paddocks: Row[]; flocks: FlockOpt[]; canWrite: boolean }) {
  const [open, setOpen] = useState(false)
  const [slug, setSlug] = useState('')
  const [error, setError] = useState<string | undefined>()

  async function onSave(fd: FormData) {
    const r = await savePaddockAction(null, fd)
    if (r.error) setError(r.error)
    else { setOpen(false); setError(undefined); setSlug('') }
  }

  return (
    <div>
      <PageHeader
        title="Paddocks"
        subtitle="Published, fenced endpoints on your Flocks."
        actions={canWrite && flocks.length > 0 && <Button onClick={() => setOpen(true)}>New paddock</Button>}
      />
      {flocks.length === 0 && (
        <p className="mb-4 text-sm text-[var(--color-muted)]">Connect a Flock first, then publish a Paddock on it.</p>
      )}
      <DataTable headers={['Name', 'Public URL', 'Flock', 'Status', '']}>
        {paddocks.map((p) => (
          <tr key={p.id} className={cn('border-b border-[var(--color-divider)]', p.status !== 'active' && 'opacity-50')}>
            <td className="px-3 py-2 text-[var(--color-text)]">{p.name}</td>
            <td className="px-3 py-2 font-mono text-xs text-[var(--color-muted)]">/p/{p.slug}</td>
            <td className="px-3 py-2"><BreedChip breed={p.breed} /> <span className="text-[var(--color-muted)]">{p.flockName}</span></td>
            <td className="px-3 py-2"><StatusPill ok={p.status === 'active'} labels={['Active', 'Disabled']} /></td>
            <td className="px-3 py-2 text-right">
              <Link href={`/paddocks/${p.id}/fence`} className="mr-3 text-sm text-[var(--color-primary)] hover:underline">Fence</Link>
              {p.breed === 'comfyui' && (
                <Link href={`/paddocks/${p.id}/templates`} className="mr-3 text-sm text-[var(--color-primary)] hover:underline">Templates</Link>
              )}
              {canWrite && (
                <>
                  <form action={togglePaddockStatusAction} className="inline">
                    <input type="hidden" name="id" value={p.id} />
                    <input type="hidden" name="status" value={p.status} />
                    <Button variant="ghost" type="submit">{p.status === 'active' ? 'Disable' : 'Enable'}</Button>
                  </form>
                  <form action={deletePaddockAction} className="ml-2 inline">
                    <input type="hidden" name="id" value={p.id} />
                    <Button variant="danger" type="submit">Delete</Button>
                  </form>
                </>
              )}
            </td>
          </tr>
        ))}
        {paddocks.length === 0 && (
          <tr><td colSpan={5} className="px-3 py-8 text-center text-[var(--color-muted)]">No paddocks yet.</td></tr>
        )}
      </DataTable>

      <Drawer open={open} onClose={() => setOpen(false)} title="New paddock">
        <form action={onSave} className="flex flex-col gap-4">
          <div>
            <Label htmlFor="flockId">Flock</Label>
            <Select id="flockId" name="flockId" required>
              {flocks.map((f) => <option key={f.id} value={f.id}>{f.name} ({f.breed})</option>)}
            </Select>
          </div>
          <div><Label htmlFor="name">Name</Label><Input id="name" name="name" required /></div>
          <div>
            <Label htmlFor="slug">Slug</Label>
            <Input id="slug" name="slug" value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="small-models" required />
            <p className="mt-1 font-mono text-xs text-[var(--color-faint)]">Public URL: /p/{slug || '<slug>'}</p>
          </div>
          <div>
            <Label htmlFor="theme">Consumer theme</Label>
            <Select id="theme" name="theme" defaultValue="plain">
              <option value="plain">Plain</option>
              <option value="metaboy">MetaBoy</option>
            </Select>
          </div>
          <input type="hidden" name="status" value="active" />
          {error && <div className="text-sm text-[var(--color-danger)]">{error}</div>}
          <Button type="submit">Publish paddock</Button>
        </form>
      </Drawer>
    </div>
  )
}
