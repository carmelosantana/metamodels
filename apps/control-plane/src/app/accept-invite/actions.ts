'use server'
import { redirect } from 'next/navigation'
import { getDb } from '../../server/db'
import { acceptInvite } from '../../server/invites-service'
import { setSessionCookie } from '../../server/current-user'

export async function acceptInviteAction(_prev: unknown, fd: FormData): Promise<{ error?: string }> {
  const token = String(fd.get('token') ?? '')
  const password = String(fd.get('password') ?? '')
  const confirm = String(fd.get('confirm') ?? '')
  if (password !== confirm) return { error: 'Passwords do not match.' }
  let actor
  try {
    actor = await acceptInvite(getDb(), token, password, Date.now())
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Could not accept this invite.' }
  }
  await setSessionCookie(actor)
  redirect('/')
}
