export interface Bar { label: string; value: number; highlight?: boolean }

/** Pure-CSS vertical bar chart (no chart library). Bars scale to the max value. */
export function BarChart({ bars, height = 160 }: { bars: Bar[]; height?: number }) {
  const max = Math.max(1, ...bars.map((b) => b.value))
  return (
    <div className="flex items-end gap-2" style={{ height }}>
      {bars.map((b, i) => (
        <div key={i} className="flex flex-1 flex-col items-center justify-end gap-1">
          <div
            className={b.highlight ? 'w-full rounded-t-sm bg-[var(--color-comfyui)]' : 'w-full rounded-t-sm bg-[var(--color-primary)]'}
            style={{ height: `${(b.value / max) * 100}%` }}
            title={`${b.label}: ${b.value.toLocaleString()}`}
          />
          <span className="text-[10px] text-[var(--color-muted)]">{b.label}</span>
        </div>
      ))}
    </div>
  )
}
