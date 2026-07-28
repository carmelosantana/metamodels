'use client'
import { useState } from 'react'
import Link from 'next/link'
import { PageHeader } from '../../../../../components/page-header'
import { Button } from '../../../../../components/ui/button'
import { Input } from '../../../../../components/ui/input'
import { Label } from '../../../../../components/ui/label'
import { Select } from '../../../../../components/ui/select'
import { cn } from '../../../../../components/ui/cn'
import { BlastRadiusCard } from '../../../../../components/ui/blast-radius-card'
import type { BlastRadius } from '../../../../../server/blast-radius'
import { saveFenceAction } from './actions'

const OLLAMA_ROUTES = ['chat', 'generate', 'embed', 'read'] as const
const METER_DIMS = ['tokens_in', 'tokens_out', 'jobs', 'gpu_ms', 'images'] as const

interface Paddock { id: string; name: string; slug: string; breed: string }

export function FenceClient({
  paddock, constraintJson, rateLimit, quota, blastRadius, canWrite,
}: {
  paddock: Paddock
  constraintJson: unknown
  rateLimit: { windowSec: number; max: number } | null
  quota: Array<{ dim: string; max: number; period: string }> | null
  blastRadius: BlastRadius
  canWrite: boolean
}) {
  const c = (constraintJson ?? {}) as { allowedRoutes?: string[]; allowedModels?: string[] | null }
  const q0 = quota?.[0]
  const [error, setError] = useState<string | undefined>()
  const [saved, setSaved] = useState(false)

  async function onSave(fd: FormData) {
    setError(undefined); setSaved(false)
    const r = await saveFenceAction(null, fd)
    if (r.error) setError(r.error)
    else setSaved(true)
  }

  return (
    <div>
      <PageHeader
        title={`Fence — ${paddock.name}`}
        subtitle={`Policy for /p/${paddock.slug}`}
        actions={<Link href="/paddocks" className="text-sm text-[var(--color-muted)] hover:underline">← Paddocks</Link>}
      />
      <div className="grid grid-cols-[1fr_320px] gap-6">
        <form action={onSave} className="flex flex-col gap-6">
          <input type="hidden" name="paddockId" value={paddock.id} />
          <input type="hidden" name="breed" value={paddock.breed} />

          {paddock.breed === 'comfyui' ? (
            <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-4 text-sm text-[var(--color-muted)]">
              Workflow templates for this ComfyUI paddock are authored in the{' '}
              <Link href={`/paddocks/${paddock.id}/templates`} className="text-[var(--color-primary)] hover:underline">
                Template editor →
              </Link>
              . Rate limit and quota still apply below.
            </div>
          ) : (
            <fieldset className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-4">
              <legend className="px-1 text-sm font-semibold">Route classes</legend>
              {OLLAMA_ROUTES.map((r) => (
                <label key={r} className="flex items-center gap-2 py-1 text-sm">
                  <input type="checkbox" name="route" value={r} defaultChecked={c.allowedRoutes?.includes(r)} />
                  <span className="font-mono">{r}</span>
                </label>
              ))}
              <div className="mt-2 flex items-center gap-2 py-1 text-sm text-[var(--color-comfyui)]">
                <input type="checkbox" disabled />
                <span className="font-mono">mutate</span>
                <span className="ml-auto">🔒 permanently locked — model management is never exposable</span>
              </div>
              <div className="mt-4">
                <Label htmlFor="models">Model allowlist (comma-separated; blank = any)</Label>
                <Input id="models" name="models" defaultValue={(c.allowedModels ?? []).join(', ')} placeholder="llama3, mistral" />
              </div>
            </fieldset>
          )}

          <fieldset className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-4">
            <legend className="px-1 text-sm font-semibold">Rate limit</legend>
            <div className="flex items-end gap-3">
              <div><Label htmlFor="rlMax">Max requests</Label><Input id="rlMax" name="rlMax" type="number" min={0} defaultValue={rateLimit?.max ?? ''} /></div>
              <div><Label htmlFor="rlWindow">Per window (sec)</Label><Input id="rlWindow" name="rlWindow" type="number" min={0} defaultValue={rateLimit?.windowSec ?? ''} /></div>
            </div>
          </fieldset>

          <fieldset className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-4">
            <legend className="px-1 text-sm font-semibold">Quota (one dimension)</legend>
            <div className="flex items-end gap-3">
              <div>
                <Label htmlFor="qDim">Dimension</Label>
                <Select id="qDim" name="qDim" defaultValue={q0?.dim ?? ''}>
                  <option value="">none</option>
                  {METER_DIMS.map((d) => <option key={d} value={d}>{d}</option>)}
                </Select>
              </div>
              <div><Label htmlFor="qMax">Max</Label><Input id="qMax" name="qMax" type="number" min={0} defaultValue={q0?.max ?? ''} /></div>
              <div>
                <Label htmlFor="qPeriod">Period</Label>
                <Select id="qPeriod" name="qPeriod" defaultValue={q0?.period ?? ''}>
                  <option value="">—</option>
                  <option value="hour">hour</option>
                  <option value="day">day</option>
                  <option value="month">month</option>
                </Select>
              </div>
            </div>
          </fieldset>

          {error && <div className="text-sm text-[var(--color-danger)]">{error}</div>}
          {saved && <div className="text-sm text-[var(--color-primary)]">Fence saved.</div>}
          {canWrite && <div><Button type="submit">Save fence</Button></div>}
        </form>

        <div className={cn(!canWrite && 'opacity-90')}>
          <BlastRadiusCard br={blastRadius} />
        </div>
      </div>
    </div>
  )
}
