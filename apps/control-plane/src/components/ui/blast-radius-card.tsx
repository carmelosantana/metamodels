import type { BlastRadius } from '../../server/blast-radius'

export function BlastRadiusCard({ br }: { br: BlastRadius }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-border)] bg-[var(--color-panel)] p-4">
      <h3 className="mb-3 text-sm font-semibold text-[var(--color-text)]">Blast radius</h3>
      <dl className="space-y-2 text-sm">
        <div className="flex justify-between"><dt className="text-[var(--color-muted)]">Breed</dt><dd className="font-mono">{br.breedId}</dd></div>
        <div className="flex justify-between">
          <dt className="text-[var(--color-muted)]">{br.breedId === 'comfyui' ? 'Templates' : 'Routes'}</dt>
          <dd className="font-mono text-right">{br.exposed.length ? br.exposed.join(', ') : '—'}{br.templateCount !== null ? ` (${br.templateCount})` : ''}</dd>
        </div>
        {br.breedId !== 'comfyui' && (
          <div className="flex justify-between"><dt className="text-[var(--color-muted)]">Models</dt><dd className="font-mono text-right">{br.models === 'any' ? 'any' : br.models.join(', ')}</dd></div>
        )}
        <div className="flex justify-between"><dt className="text-[var(--color-muted)]">Rate limit</dt><dd className="font-mono">{br.rateLimit ? `${br.rateLimit.max}/${br.rateLimit.windowSec}s` : 'none'}</dd></div>
        <div className="flex justify-between"><dt className="text-[var(--color-muted)]">Quotas</dt><dd className="font-mono text-right">{br.quota.length ? br.quota.map((q) => `${q.max} ${q.dim}/${q.period}`).join('; ') : 'none'}</dd></div>
        <div className="flex justify-between"><dt className="text-[var(--color-muted)]">Model management</dt><dd className="font-mono text-[var(--color-comfyui)]">🔒 locked</dd></div>
      </dl>
    </div>
  )
}
