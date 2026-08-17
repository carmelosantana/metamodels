'use client'
import { useState } from 'react'
import { PageHeader } from '../../../components/page-header'
import { DataTable } from '../../../components/ui/data-table'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { Label } from '../../../components/ui/label'
import { Select } from '../../../components/ui/select'
import { Switch } from '../../../components/ui/switch'
import { Drawer } from '../../../components/ui/drawer'
import { StatusPill } from '../../../components/ui/status-pill'
import { BreedChip } from '../../../components/ui/breed-chip'
import { saveFlockAction, deleteFlockAction, testConnectionAction } from './actions'

interface Row { id: string; name: string; breed: string; baseUrl: string; healthOk: boolean | null }

export function FlocksClient({ flocks, canWrite }: { flocks: Row[]; canWrite: boolean }) {
  const [open, setOpen] = useState(false)
  const [tls, setTls] = useState(false)
  const [test, setTest] = useState<{ ok: boolean; detail?: string } | null>(null)
  const [error, setError] = useState<string | undefined>()
  // Controlled, because React resets a form once its action resolves. "Test connection"
  // is an action, so uncontrolled fields would be wiped the moment the test came back —
  // leaving the operator staring at "Connection OK" above an empty form.
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [upstreamAuth, setUpstreamAuth] = useState('')

  function resetForm() {
    setName('')
    setBaseUrl('')
    setUpstreamAuth('')
    setTls(false)
    setTest(null)
    setError(undefined)
  }

  async function onSave(fd: FormData) {
    fd.set('tlsTrust', String(tls))
    const r = await saveFlockAction(null, fd)
    if (r.error) setError(r.error)
    else { setOpen(false); resetForm() }
  }

  async function onTest(fd: FormData) {
    fd.set('tlsTrust', String(tls))
    setTest(await testConnectionAction(fd))
  }

  return (
    <div>
      <PageHeader
        title="Flocks"
        subtitle="Connected local AI servers behind your fence."
        actions={canWrite && <Button onClick={() => { resetForm(); setOpen(true) }}>Connect a flock</Button>}
      />
      <DataTable headers={['Name', 'Breed', 'Base URL', 'Health', '']}>
        {flocks.map((f) => (
          <tr key={f.id} className="border-b border-[var(--color-divider)]">
            <td className="px-3 py-2 text-[var(--color-text)]">{f.name}</td>
            <td className="px-3 py-2"><BreedChip breed={f.breed} /></td>
            <td className="px-3 py-2 font-mono text-xs text-[var(--color-muted)]">{f.baseUrl}</td>
            <td className="px-3 py-2"><StatusPill ok={f.healthOk} /></td>
            <td className="px-3 py-2 text-right">
              {canWrite && (
                <form action={deleteFlockAction} className="inline">
                  <input type="hidden" name="id" value={f.id} />
                  <Button variant="danger" type="submit">Delete</Button>
                </form>
              )}
            </td>
          </tr>
        ))}
        {flocks.length === 0 && (
          <tr><td colSpan={5} className="px-3 py-8 text-center text-[var(--color-muted)]">No flocks yet. Connect one to get started.</td></tr>
        )}
      </DataTable>

      <Drawer open={open} onClose={() => setOpen(false)} title="Connect a flock">
        <form action={onSave} className="flex flex-col gap-4">
          <div>
            <Label htmlFor="breed">Breed</Label>
            <Select id="breed" name="breed" defaultValue="ollama">
              <option value="ollama">ollama</option>
              <option value="comfyui">comfyui</option>
            </Select>
          </div>
          <div><Label htmlFor="name">Name</Label><Input id="name" name="name" value={name} onChange={(e) => setName(e.target.value)} required /></div>
          <div><Label htmlFor="baseUrl">Base URL</Label><Input id="baseUrl" name="baseUrl" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:11434" required /></div>
          <div><Label htmlFor="upstreamAuth">Upstream auth (optional)</Label><Input id="upstreamAuth" name="upstreamAuth" value={upstreamAuth} onChange={(e) => setUpstreamAuth(e.target.value)} /></div>
          <div className="flex items-center gap-2">
            <Switch checked={tls} onChange={setTls} name="tlsTrust" />
            <span className="text-sm text-[var(--color-muted)]">Trust self-signed TLS</span>
          </div>
          {test && (
            <div className={test.ok ? 'text-sm text-[var(--color-primary)]' : 'text-sm text-[var(--color-danger)]'}>
              {test.ok ? 'Connection OK' : `Failed: ${test.detail ?? 'unreachable'}`}
            </div>
          )}
          {error && <div className="text-sm text-[var(--color-danger)]">{error}</div>}
          <div className="flex gap-2">
            <Button type="submit">Save</Button>
            <Button type="submit" variant="ghost" formAction={onTest}>Test connection</Button>
          </div>
        </form>
      </Drawer>
    </div>
  )
}
