'use server'
import { revalidatePath } from 'next/cache'
import { getDb } from '../../../server/db'
import { requireUser } from '../../../server/guard'
import { requireCapability } from '../../../auth/authorize'
import { isRole } from '../../../auth/authorize'
import { changeUserRole, setUserStatus } from '../../../server/users-service'
import { inviteUser, revokeInvite } from '../../../server/invites-service'
import { getSeatLimit } from '../../../server/seats'

export async function inviteUserAction(
  _prev: unknown, fd: FormData,
): Promise<{ error?: string; token?: string; email?: string }> {
  const actor = await requireUser()
  try {
    requireCapability(actor, 'user.manage')
    const db = getDb()
    const seatLimit = await getSeatLimit(db, actor.orgId)
    const created = await inviteUser(db, actor, {
      email: String(fd.get('email') ?? '').trim(),
      role: String(fd.get('role') ?? 'member'),
    }, seatLimit, Date.now())
    revalidatePath('/team')
    return { token: created.token, email: created.email }
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed to invite user' }
  }
}

export async function revokeInviteAction(fd: FormData): Promise<{ error?: string }> {
  const actor = await requireUser()
  try {
    requireCapability(actor, 'user.manage')
    await revokeInvite(getDb(), actor, String(fd.get('id')))
    revalidatePath('/team')
    return {}
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed to revoke invite' }
  }
}

export async function changeRoleAction(fd: FormData): Promise<{ error?: string }> {
  const actor = await requireUser()
  try {
    requireCapability(actor, 'user.manage')
    const role = String(fd.get('role') ?? '')
    if (!isRole(role)) return { error: 'Invalid role' }
    await changeUserRole(getDb(), actor, String(fd.get('id')), role)
    revalidatePath('/team')
    return {}
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed to change role' }
  }
}

export async function setStatusAction(fd: FormData): Promise<{ error?: string }> {
  const actor = await requireUser()
  try {
    requireCapability(actor, 'user.manage')
    const db = getDb()
    const status = String(fd.get('status') ?? '') === 'active' ? 'active' : 'deactivated'
    const seatLimit = await getSeatLimit(db, actor.orgId)
    await setUserStatus(db, actor, String(fd.get('id')), status, seatLimit, Date.now())
    revalidatePath('/team')
    return {}
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed to update user' }
  }
}
