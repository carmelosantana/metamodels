import { cn } from './cn'

export function BreedChip({ breed }: { breed: string }) {
  const isComfy = breed === 'comfyui'
  return (
    <span className={cn(
      'inline-flex rounded-[var(--radius-chip)] px-2 py-0.5 font-mono text-xs',
      isComfy ? 'text-[var(--color-comfyui)] bg-[var(--color-comfyui)]/10' : 'text-[var(--color-primary)] bg-[var(--color-primary)]/10',
    )}>
      {breed}
    </span>
  )
}
