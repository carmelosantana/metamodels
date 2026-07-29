'use client'
import { useState } from 'react'
import { PageHeader } from '../../../components/page-header'
import { DataTable } from '../../../components/ui/data-table'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { Label } from '../../../components/ui/label'
import { Drawer } from '../../../components/ui/drawer'
import { StatusPill } from '../../../components/ui/status-pill'
import { inviteUserAction, revokeInviteAction, changeRoleAction, setStatusAction } from './actions'

const ROLES = ['admin', 'member', 'viewer'] as const

interface Usage { used: number; limit: number; free: number }
interface UserItem { id: string; email: string; role: string; status: string; createdAt: string }
interface InviteItem { id: string; email: string; role: string; expiresAt: string }

const selectClass =
  'rounded-[var(--radius-control)] border border-[var(--color-border)] bg-[var(--color-panel)] p-2 text-sm text-[var(--color-text)]'

export function TeamClient(
  { selfId, usage, users, invites }: { selfId: string; usage: Usage; users: UserItem[]; invites: InviteItem[] },
) {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [reveal, setReveal] = useState<{ email: string; link: string } | null>(null)

  async function onInvite(fd: FormData) {
    const r = await inviteUserAction(null, fd)
    if (r.error) { setError(r.error); return }
    setError(undefined)
    setOpen(false)
    if (r.token) setReveal({ email: r.email ?? '', link: `${location.origin}/accept-invite?token=${r.token}` })
  }

  return (
    <div>
      <PageHeader
        title="Team"
        subtitle={`${usage.used} / ${usage.limit} seats used · ${usage.free} free`}
        actions={<Button onClick={() => { setError(undefined); setOpen(true) }}>Invite user</Button>}
      />

      {reveal && (
        <div className="mb-4 rounded-[var(--radius-control)] border border-[var(--color-primary)] bg-[var(--color-panel-2)] p-4">
          <div className="mb-1 text-sm font-semibold text-[var(--color-primary)]">
            Copy this invite link now — it will not be shown again.
          </div>
          <div className="mb-1 text-xs text-[var(--color-muted)]">Invited {reveal.email}</div>
          <code className="block break-all font-mono text-sm text-[var(--color-text)]">{reveal.link}</code>
          <div className="mt-2">
            <Button variant="ghost" onClick={() => setReveal(null)}>Done</Button>
          </div>
        </div>
      )}

      <DataTable headers={['Email', 'Role', 'Status', 'Created', '']}>
        {users.map((u) => (
          <tr key={u.id} className="border-b border-[var(--color-divider)]">
            <td className="px-3 py-2 text-[var(--color-text)]">{u.email}</td>
            <td className="px-3 py-2">
              <form action={async (fd) => { await changeRoleAction(fd) }} className="inline">
                <input type="hidden" name="id" value={u.id} />
                <select
                  name="role" defaultValue={u.role} className={selectClass}
                  onChange={(e) => e.currentTarget.form?.requestSubmit()}
                >
                  {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </form>
            </td>
            <td className="px-3 py-2"><StatusPill ok={u.status === 'active'} labels={['Active', 'Deactivated']} /></td>
            <td className="px-3 py-2 text-xs text-[var(--color-muted)]">{u.createdAt.slice(0, 10)}</td>
            <td className="px-3 py-2 text-right">
              <form action={async (fd) => { await setStatusAction(fd) }} className="inline">
                <input type="hidden" name="id" value={u.id} />
                <input type="hidden" name="status" value={u.status === 'active' ? 'deactivated' : 'active'} />
                {u.status === 'active' ? (
                  <Button variant="danger" type="submit" disabled={u.id === selfId}>Deactivate</Button>
                ) : (
                  <Button variant="ghost" type="submit">Reactivate</Button>
                )}
              </form>
            </td>
          </tr>
        ))}
        {users.length === 0 && (
          <tr><td colSpan={5} className="px-3 py-8 text-center text-[var(--color-muted)]">No users yet.</td></tr>
        )}
      </DataTable>

      <h2 className="mt-8 mb-3 text-sm font-semibold text-[var(--color-text)]">Pending invites</h2>
      <DataTable headers={['Email', 'Role', 'Expires', '']}>
        {invites.map((i) => (
          <tr key={i.id} className="border-b border-[var(--color-divider)]">
            <td className="px-3 py-2 text-[var(--color-text)]">{i.email}</td>
            <td className="px-3 py-2 text-xs text-[var(--color-muted)]">{i.role}</td>
            <td className="px-3 py-2 text-xs text-[var(--color-muted)]">{i.expiresAt.slice(0, 10)}</td>
            <td className="px-3 py-2 text-right">
              <form action={async (fd) => { await revokeInviteAction(fd) }} className="inline">
                <input type="hidden" name="id" value={i.id} />
                <Button variant="danger" type="submit">Revoke</Button>
              </form>
            </td>
          </tr>
        ))}
        {invites.length === 0 && (
          <tr><td colSpan={4} className="px-3 py-8 text-center text-[var(--color-muted)]">No pending invites.</td></tr>
        )}
      </DataTable>

      <Drawer open={open} onClose={() => setOpen(false)} title="Invite user">
        <form action={onInvite} className="flex flex-col gap-4">
          <div><Label htmlFor="email">Email</Label><Input id="email" name="email" type="email" required /></div>
          <div>
            <Label htmlFor="role">Role</Label>
            <select id="role" name="role" defaultValue="member" className={`w-full ${selectClass}`}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          {error && <div className="text-sm text-[var(--color-danger)]">{error}</div>}
          <div className="flex gap-2">
            <Button type="submit">Send invite</Button>
          </div>
        </form>
      </Drawer>
    </div>
  )
}
