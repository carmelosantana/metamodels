import { getDb } from '../../../server/db'
import { requireUser } from '../../../server/guard'
import { usageMatrix, dailySeries } from '../../../server/usage-service'
import { listKeys } from '../../../server/keys-service'
import { listPaddocks } from '../../../server/paddocks-service'
import { resolveRange, isUsageRange } from '../../../lib/usage-range'
import { UsageClient } from './usage-client'

const HEADLINE = 'tokens_out' as const

export default async function UsagePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const actor = await requireUser()
  const db = getDb()

  const rangeParam = typeof sp.range === 'string' && isUsageRange(sp.range) ? sp.range : '7d'
  const keyId = typeof sp.key === 'string' && sp.key ? sp.key : undefined
  const paddockId = typeof sp.paddock === 'string' && sp.paddock ? sp.paddock : undefined
  const { startBucket, endBucket, days } = resolveRange(rangeParam, Date.now())

  const [matrix, series, keys, paddocks] = await Promise.all([
    usageMatrix(db, actor, { startBucket, endBucket, keyId, paddockId }),
    dailySeries(db, actor, { dim: HEADLINE, startBucket, endBucket, keyId, paddockId }),
    listKeys(db, actor),
    listPaddocks(db, actor),
  ])

  // Fill every day in the range (dailySeries is sparse).
  const byDay = new Map(series.map((p) => [p.day, p.value]))
  const bars = days.map((d) => ({ label: d.slice(5), value: byDay.get(d) ?? 0 })) // label = MM-DD
  const total = bars.reduce((s, b) => s + b.value, 0)

  return (
    <UsageClient
      range={rangeParam}
      keyId={keyId ?? ''}
      paddockId={paddockId ?? ''}
      bars={bars}
      total={total}
      rows={matrix}
      keys={keys.map((k) => ({ id: k.id, name: k.name }))}
      paddocks={paddocks.map((p) => ({ id: p.id, slug: p.slug }))}
    />
  )
}
