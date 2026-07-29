import { requireCapabilityOr403 } from '../../../server/guard'
import { getDb } from '../../../server/db'
import { getEntitlement } from '../../../server/entitlement-service'
import { getSeatLimit, seatUsage } from '../../../server/seats'
import { SettingsClient } from './settings-client'

export default async function SettingsPage() {
  const actor = await requireCapabilityOr403('license.manage')
  const db = getDb()
  const now = Date.now()
  const [ent, limit] = await Promise.all([getEntitlement(db, actor.orgId), getSeatLimit(db, actor.orgId, now)])
  const usage = await seatUsage(db, actor, limit, now)
  return (
    <SettingsClient
      usage={usage}
      entitlement={ent ? {
        status: ent.status, seats: ent.seats, tier: ent.tier, last4: ent.last4,
        lastValidatedAt: ent.lastValidatedAt ? ent.lastValidatedAt.toISOString() : null,
        graceUntil: ent.graceUntil ? ent.graceUntil.toISOString() : null,
      } : null}
    />
  )
}
