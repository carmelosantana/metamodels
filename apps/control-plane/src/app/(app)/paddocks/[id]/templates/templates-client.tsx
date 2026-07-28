'use client'
import { useState } from 'react'
import Link from 'next/link'
import type { ParamSpec, WorkflowTemplate } from '@metamodels/connectors'
import { PageHeader } from '../../../../../components/page-header'
import { Button } from '../../../../../components/ui/button'
import { Input } from '../../../../../components/ui/input'
import { Label } from '../../../../../components/ui/label'
import { Select } from '../../../../../components/ui/select'
import { parseGraphText, graphTargets } from '../../../../../lib/graph-parse'
import { saveTemplateAction, deleteTemplateAction, dryRunTemplateAction } from './actions'

type ParamType = ParamSpec['type']
interface Row { name: string; type: ParamType; node: string; input: string; min?: string; max?: string; seedTargets: { node: string; input: string }[] }
type Targets = { node: string; inputs: string[] }[]

const PARAM_TYPES: ParamType[] = ['text', 'seed', 'number', 'image']

function toParamSpec(r: Row): ParamSpec {
  if (r.type === 'seed') return { name: r.name, type: 'seed', targets: r.seedTargets.map((t) => ({ node: t.node, input: t.input })) }
  if (r.type === 'number') {
    const spec: ParamSpec = { name: r.name, type: 'number', target: { node: r.node, input: r.input } }
    if (r.min !== undefined && r.min !== '') spec.min = Number(r.min)
    if (r.max !== undefined && r.max !== '') spec.max = Number(r.max)
    return spec
  }
  if (r.type === 'image') return { name: r.name, type: 'image', target: { node: r.node, input: r.input } }
  return { name: r.name, type: 'text', target: { node: r.node, input: r.input } }
}

function specToRow(s: ParamSpec): Row {
  if (s.type === 'seed') return { name: s.name, type: 'seed', node: '', input: '', seedTargets: s.targets.map((t) => ({ ...t })) }
  const base = { name: s.name, node: s.target.node, input: s.target.input, seedTargets: [] as Row['seedTargets'] }
  if (s.type === 'number') return { ...base, type: 'number', min: s.min?.toString() ?? '', max: s.max?.toString() ?? '' }
  return { ...base, type: s.type }
}

export function TemplatesClient({
  paddock, templates, canWrite,
}: {
  paddock: { id: string; name: string; slug: string }
  templates: WorkflowTemplate[]
  canWrite: boolean
}) {
  const [id, setId] = useState('')
  const [cost, setCost] = useState('1')
  const [graphText, setGraphText] = useState('')
  const [targets, setTargets] = useState<Targets>([])
  const [rows, setRows] = useState<Row[]>([])
  const [parseErr, setParseErr] = useState<string | undefined>()
  const [dry, setDry] = useState<{ ok: boolean; reason?: string } | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [saved, setSaved] = useState(false)

  function loadTemplate(t: WorkflowTemplate) {
    setId(t.id); setCost(String(t.cost)); const gt = JSON.stringify(t.graph, null, 2); setGraphText(gt)
    const parsed = parseGraphText(gt); setTargets(parsed.ok ? graphTargets(parsed.value) : [])
    setRows(t.params.map(specToRow)); setParseErr(undefined); setDry(undefined); setError(undefined); setSaved(false)
  }
  function onParse() {
    const r = parseGraphText(graphText)
    if (!r.ok) { setParseErr(r.reason); setTargets([]); return }
    setParseErr(undefined); setTargets(graphTargets(r.value))
  }
  function draft() { return { id, graphText, params: rows.map(toParamSpec), cost: Number(cost) } }
  async function onValidate() { setDry(await dryRunTemplateAction(draft())) }
  function addRow() { setRows((rs) => [...rs, { name: '', type: 'text', node: '', input: '', seedTargets: [{ node: '', input: '' }] }]) }
  function setRow(i: number, patch: Partial<Row>) { setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r))) }
  function removeRow(i: number) { setRows((rs) => rs.filter((_, j) => j !== i)) }

  async function onSave(fd: FormData) {
    setError(undefined); setSaved(false)
    fd.set('draft', JSON.stringify(draft()))
    const r = await saveTemplateAction(null, fd)
    if (r.error) setError(r.error); else setSaved(true)
  }

  const inputsFor = (node: string) => targets.find((t) => t.node === node)?.inputs ?? []

  return (
    <div>
      <PageHeader
        title={`Templates — ${paddock.name}`}
        subtitle={`ComfyUI workflow templates for /p/${paddock.slug}`}
        actions={<Link href="/paddocks" className="text-sm text-[var(--color-muted)] hover:underline">← Paddocks</Link>}
      />
      <div className="grid grid-cols-[280px_1fr] gap-6">
        <aside className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">Templates ({templates.length})</h2>
          {templates.length === 0 && <p className="text-sm text-[var(--color-muted)]">None yet. Paste a workflow →</p>}
          {templates.map((t) => (
            <div key={t.id} className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-3 text-sm">
              <div className="font-mono">{t.id}</div>
              <div className="text-[var(--color-muted)]">{t.params.length} params · cost {t.cost}</div>
              {canWrite && (
                <div className="mt-2 flex gap-2">
                  <button type="button" className="text-[var(--color-primary)] hover:underline" onClick={() => loadTemplate(t)}>Edit</button>
                  <form action={async (fd) => { await deleteTemplateAction(null, fd) }}>
                    <input type="hidden" name="paddockId" value={paddock.id} />
                    <input type="hidden" name="templateId" value={t.id} />
                    <button type="submit" className="text-[var(--color-danger)] hover:underline">Delete</button>
                  </form>
                </div>
              )}
            </div>
          ))}
        </aside>

        <form action={onSave} className="flex flex-col gap-4">
          <input type="hidden" name="paddockId" value={paddock.id} />
          <div className="flex gap-3">
            <div className="flex-1"><Label htmlFor="tid">Template id</Label><Input id="tid" value={id} onChange={(e) => setId(e.target.value)} placeholder="txt2img" /></div>
            <div className="w-28"><Label htmlFor="tcost">Cost</Label><Input id="tcost" type="number" min={0} value={cost} onChange={(e) => setCost(e.target.value)} /></div>
          </div>

          <div>
            <Label htmlFor="graph">Workflow-API JSON</Label>
            <textarea id="graph" value={graphText} onChange={(e) => setGraphText(e.target.value)} rows={8}
              className="w-full rounded-[var(--radius-input)] border border-[var(--color-border)] bg-[var(--color-bg)] p-2 font-mono text-xs" />
            <div className="mt-2 flex items-center gap-3">
              <Button type="button" variant="ghost" onClick={onParse}>Parse graph</Button>
              {parseErr && <span className="text-sm text-[var(--color-danger)]">{parseErr}</span>}
              {!parseErr && targets.length > 0 && <span className="text-sm text-[var(--color-muted)]">{targets.length} nodes parsed</span>}
            </div>
          </div>

          <fieldset className="rounded-[var(--radius-card)] border border-[var(--color-border)] p-4">
            <legend className="px-1 text-sm font-semibold">Parameters</legend>
            {rows.map((r, i) => (
              <div key={i} className="mb-3 flex flex-wrap items-end gap-2 border-b border-[var(--color-border)] pb-3">
                <div><Label htmlFor={`n${i}`}>name</Label><Input id={`n${i}`} value={r.name} onChange={(e) => setRow(i, { name: e.target.value })} /></div>
                <div><Label htmlFor={`t${i}`}>type</Label>
                  <Select id={`t${i}`} value={r.type} onChange={(e) => setRow(i, { type: e.target.value as ParamType })}>
                    {PARAM_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </Select>
                </div>
                {r.type === 'seed' ? (
                  <div className="text-xs text-[var(--color-muted)]">seed is server-generated each run — declare its target node(s):
                    {r.seedTargets.map((st, k) => (
                      <div key={k} className="mt-1 flex gap-1">
                        <Select value={st.node} onChange={(e) => setRow(i, { seedTargets: r.seedTargets.map((x, j) => j === k ? { ...x, node: e.target.value, input: '' } : x) })}>
                          <option value="">node</option>{targets.map((t) => <option key={t.node} value={t.node}>{t.node}</option>)}
                        </Select>
                        <Select value={st.input} onChange={(e) => setRow(i, { seedTargets: r.seedTargets.map((x, j) => j === k ? { ...x, input: e.target.value } : x) })}>
                          <option value="">input</option>{inputsFor(st.node).map((inp) => <option key={inp} value={inp}>{inp}</option>)}
                        </Select>
                      </div>
                    ))}
                    <button type="button" className="mt-1 text-[var(--color-primary)]" onClick={() => setRow(i, { seedTargets: [...r.seedTargets, { node: '', input: '' }] })}>+ target</button>
                  </div>
                ) : (
                  <>
                    <div><Label htmlFor={`nd${i}`}>node</Label>
                      <Select id={`nd${i}`} value={r.node} onChange={(e) => setRow(i, { node: e.target.value, input: '' })}>
                        <option value="">—</option>{targets.map((t) => <option key={t.node} value={t.node}>{t.node}</option>)}
                      </Select>
                    </div>
                    <div><Label htmlFor={`in${i}`}>input</Label>
                      <Select id={`in${i}`} value={r.input} onChange={(e) => setRow(i, { input: e.target.value })}>
                        <option value="">—</option>{inputsFor(r.node).map((inp) => <option key={inp} value={inp}>{inp}</option>)}
                      </Select>
                    </div>
                    {r.type === 'number' && (
                      <>
                        <div className="w-20"><Label htmlFor={`mn${i}`}>min</Label><Input id={`mn${i}`} type="number" value={r.min ?? ''} onChange={(e) => setRow(i, { min: e.target.value })} /></div>
                        <div className="w-20"><Label htmlFor={`mx${i}`}>max</Label><Input id={`mx${i}`} type="number" value={r.max ?? ''} onChange={(e) => setRow(i, { max: e.target.value })} /></div>
                      </>
                    )}
                  </>
                )}
                <button type="button" className="text-[var(--color-danger)]" onClick={() => removeRow(i)}>remove</button>
              </div>
            ))}
            <Button type="button" variant="ghost" onClick={addRow}>+ Add parameter</Button>
          </fieldset>

          <div className="flex items-center gap-3">
            <Button type="button" variant="ghost" onClick={onValidate}>Validate (dry run)</Button>
            {dry?.ok && <span className="text-sm text-[var(--color-primary)]">✓ reconstructs OK</span>}
            {dry && !dry.ok && <span className="text-sm text-[var(--color-danger)]">✗ {dry.reason}</span>}
          </div>

          {error && <div className="text-sm text-[var(--color-danger)]">{error}</div>}
          {saved && <div className="text-sm text-[var(--color-primary)]">Template saved.</div>}
          {canWrite && <div><Button type="submit">Save template</Button></div>}
        </form>
      </div>
    </div>
  )
}
