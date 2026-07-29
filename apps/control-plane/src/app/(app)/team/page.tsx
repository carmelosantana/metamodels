import { requireCapabilityOr403 } from '../../../server/guard'
import { getDb } from '../../../server/db'
import { listUsers } from '../../../server/users-service'
import { listPendingInvites } from '../../../server/invites-service'
import { getSeatLimit, seatUsage } from '../../../server/seats'
import { TeamClient } from './team-client'

export default async function TeamPage() {
  const actor = await requireCapabilityOr403('user.manage')
  const db = getDb()
  const now = Date.now()
  const seatLimit = await getSeatLimit(db, actor.orgId, now)
  const [users, invites, usage] = await Promise.all([
    listUsers(db, actor),
    listPendingInvites(db, actor, now),
    seatUsage(db, actor, seatLimit, now),
  ])
  return (
    <TeamClient
      selfId={actor.id}
      usage={usage}
      users={users.map((u) => ({ id: u.id, email: u.email, role: u.role, status: u.status, createdAt: u.createdAt.toISOString() }))}
      invites={invites.map((i) => ({ id: i.id, email: i.email, role: i.role, expiresAt: i.expiresAt.toISOString() }))}
    />
  )
}
