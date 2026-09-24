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
import { movesCredential } from '../../../lib/flock-form'
import { saveFlockAction, deleteFlockAction, testConnectionAction, testStoredFlockAction } from './actions'

interface Row { id: string; name: string; breed: string; baseUrl: string; tlsTrust: boolean; healthOk: boolean | null; hasUpstreamAuth: boolean }
type TestResult = { ok: boolean; detail?: string }
/** What to do with a stored credential on save. Only offered when one is stored. */
type CredentialChoice = 'keep' | 'replace' | 'remove'

function TestOutcome({ result }: { result: TestResult }) {
  return (
    <span className={result.ok ? 'text-sm text-[var(--color-primary)]' : 'text-sm text-[var(--color-danger)]'}>
      {result.ok ? 'Connection OK' : `Failed: ${result.detail ?? 'unreachable'}`}
    </span>
  )
}

const TOKEN_HINT = (
  <p className="mt-1 text-xs text-[var(--color-muted)]">The token only, without &ldquo;Bearer&rdquo;. It is sent as <code>Authorization: Bearer &lt;token&gt;</code>, stored encrypted, and never shown again.</p>
)

export function FlocksClient({ flocks, canWrite }: { flocks: Row[]; canWrite: boolean }) {
  const [open, setOpen] = useState(false)
  // The flock being edited, or null when connecting a new one.
  const [editing, setEditing] = useState<Row | null>(null)
  const [tls, setTls] = useState(false)
  const [test, setTest] = useState<TestResult | null>(null)
  const [rowTests, setRowTests] = useState<Record<string, TestResult | 'pending'>>({})
  const [error, setError] = useState<string | undefined>()
  // Controlled, because React resets a form once its action resolves. "Test connection"
  // is an action, so uncontrolled fields would be wiped the moment the test came back —
  // leaving the operator staring at "Connection OK" above an empty form.
  const [breed, setBreed] = useState('ollama')
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [upstreamAuth, setUpstreamAuth] = useState('')
  const [credential, setCredential] = useState<CredentialChoice>('keep')

  // The stored credential is never sent to the browser, so there is nothing to pre-fill: the edit
  // drawer offers Keep / Replace / Remove instead.
  const stored = editing?.hasUpstreamAuth === true
  // Keeping a stored credential while re-pointing the flock is what `saveFlock` refuses. Warn here;
  // the server's refusal is still what stops it.
  const rebind = stored && credential === 'keep' && editing !== null &&
    movesCredential(editing, { baseUrl: baseUrl.trim(), tlsTrust: tls })

  function resetForm(row: Row | null) {
    setEditing(row)
    setBreed(row?.breed ?? 'ollama')
    setName(row?.name ?? '')
    setBaseUrl(row?.baseUrl ?? '')
    setTls(row?.tlsTrust ?? false)
    setUpstreamAuth('')
    setCredential('keep')
    setTest(null)
    setError(undefined)
  }

  function close() {
    setOpen(false)
    resetForm(null)
  }

  function choose(c: CredentialChoice) {
    setCredential(c)
    // A token typed under Replace does not linger once the operator backs out of it.
    if (c !== 'replace') setUpstreamAuth('')
    setTest(null)
  }

  async function onSave(fd: FormData) {
    fd.set('tlsTrust', String(tls))
    const r = await saveFlockAction(null, fd)
    if (r.error) { setError(r.error); return }
    // A row's last Test result described the flock as it was before this save.
    const id = editing?.id
    if (id) setRowTests(({ [id]: _stale, ...rest }) => rest)
    close()
  }

  async function onTest(fd: FormData) {
    // Keeping a stored credential: test the flock as saved, with the credential opened on the
    // server. The form's URL and TLS are unchanged here, or the button is disabled (`rebind`).
    if (editing && stored && credential === 'keep') {
      setTest(await testStoredFlockAction(editing.id))
      return
    }
    fd.set('tlsTrust', String(tls))
    setTest(await testConnectionAction(fd))
  }

  async function onRowTest(id: string) {
    setRowTests((t) => ({ ...t, [id]: 'pending' }))
    const r = await testStoredFlockAction(id)
    setRowTests((t) => ({ ...t, [id]: r }))
  }

  return (
    <div>
      <PageHeader
        title="Flocks"
        subtitle="Connected local AI servers behind your fence."
        actions={canWrite && <Button onClick={() => { resetForm(null); setOpen(true) }}>Connect a flock</Button>}
      />
      <DataTable headers={['Name', 'Breed', 'Base URL', 'Credential', 'Health', '']}>
        {flocks.map((f) => {
          const rowTest = rowTests[f.id]
          return (
            <tr key={f.id} className="border-b border-[var(--color-divider)]">
              <td className="px-3 py-2 text-[var(--color-text)]">{f.name}</td>
              <td className="px-3 py-2"><BreedChip breed={f.breed} /></td>
              <td className="px-3 py-2 font-mono text-xs text-[var(--color-muted)]">{f.baseUrl}</td>
              <td className="px-3 py-2 text-sm text-[var(--color-muted)]">{f.hasUpstreamAuth ? 'Stored' : '—'}</td>
              <td className="px-3 py-2">
                <StatusPill ok={f.healthOk} />
                {rowTest && rowTest !== 'pending' && <div className="mt-1"><TestOutcome result={rowTest} /></div>}
              </td>
              <td className="px-3 py-2 text-right">
                {canWrite && (
                  <div className="inline-flex gap-2">
                    <Button variant="ghost" type="button" disabled={rowTest === 'pending'} onClick={() => onRowTest(f.id)}>
                      {rowTest === 'pending' ? 'Testing…' : 'Test'}
                    </Button>
                    <Button variant="ghost" type="button" onClick={() => { resetForm(f); setOpen(true) }}>Edit</Button>
                    <form action={deleteFlockAction} className="inline">
                      <input type="hidden" name="id" value={f.id} />
                      <Button variant="danger" type="submit">Delete</Button>
                    </form>
                  </div>
                )}
              </td>
            </tr>
          )
        })}
        {flocks.length === 0 && (
          <tr><td colSpan={6} className="px-3 py-8 text-center text-[var(--color-muted)]">No flocks yet. Connect one to get started.</td></tr>
        )}
      </DataTable>

      <Drawer open={open} onClose={close} title={editing ? 'Edit flock' : 'Connect a flock'}>
        <form action={onSave} className="flex flex-col gap-4">
          {editing && <input type="hidden" name="id" value={editing.id} />}
          <div>
            <Label htmlFor="breed">Breed</Label>
            <Select id="breed" name="breed" value={breed} onChange={(e) => setBreed(e.target.value)}>
              <option value="ollama">ollama</option>
              <option value="comfyui">comfyui</option>
            </Select>
          </div>
          <div><Label htmlFor="name">Name</Label><Input id="name" name="name" value={name} onChange={(e) => setName(e.target.value)} required /></div>
          <div><Label htmlFor="baseUrl">Base URL</Label><Input id="baseUrl" name="baseUrl" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:11434" required /></div>
          {stored ? (
            <fieldset>
              <legend className="mb-1 block text-xs font-medium text-[var(--color-muted)]">
                Upstream bearer token <span className="text-[var(--color-text)]">· Stored</span>
              </legend>
              <div className="flex gap-4 text-sm text-[var(--color-text)]">
                {(['keep', 'replace', 'remove'] as const).map((c) => (
                  <label key={c} className="inline-flex items-center gap-1">
                    <input type="radio" name="credential" value={c} checked={credential === c} onChange={() => choose(c)} />
                    {c === 'keep' ? 'Keep' : c === 'replace' ? 'Replace' : 'Remove'}
                  </label>
                ))}
              </div>
              {credential === 'replace' && (
                <div className="mt-2">
                  <Label htmlFor="upstreamAuth">New upstream bearer token</Label>
                  {/* Masked, never pre-filled, and only rendered under Replace, so no other choice posts it. */}
                  <Input id="upstreamAuth" name="upstreamAuth" type="password" autoComplete="off" required value={upstreamAuth} onChange={(e) => setUpstreamAuth(e.target.value)} />
                  {TOKEN_HINT}
                </div>
              )}
              {credential === 'remove' && (
                <p className="mt-2 text-xs text-[var(--color-danger)]">The stored token is deleted when you save, and calls to this flock go out without one.</p>
              )}
              {rebind && (
                <p className="mt-2 text-xs text-[var(--color-danger)]">Changing the base URL or trusting self-signed TLS needs the token re-entered: choose Replace, or Remove.</p>
              )}
            </fieldset>
          ) : (
            <div>
              <Label htmlFor="upstreamAuth">Upstream bearer token (optional)</Label>
              {/* Masked, and never pre-filled: the credential is write-only, stored encrypted, and no read returns it. */}
              <Input id="upstreamAuth" name="upstreamAuth" type="password" autoComplete="off" value={upstreamAuth} onChange={(e) => setUpstreamAuth(e.target.value)} />
              {TOKEN_HINT}
            </div>
          )}
          <div className="flex items-center gap-2">
            <Switch checked={tls} onChange={setTls} name="tlsTrust" />
            <span className="text-sm text-[var(--color-muted)]">Trust self-signed TLS</span>
          </div>
          {test && <TestOutcome result={test} />}
          {error && <div className="text-sm text-[var(--color-danger)]">{error}</div>}
          <div className="flex gap-2">
            {credential === 'remove'
              ? <Button type="submit" variant="danger">Remove token and save</Button>
              : <Button type="submit">Save</Button>}
            <Button type="submit" variant="ghost" formAction={onTest} disabled={rebind}>Test connection</Button>
          </div>
        </form>
      </Drawer>
    </div>
  )
}
