'use server'
import { redirect } from 'next/navigation'
import { clearSessionCookie } from '../../server/current-user'
import { getOidcClient } from '../../server/oidc-session'

/** Sign out of the console, then end the OP session too (RP-initiated logout). */
export async function logout(): Promise<void> {
  await clearSessionCookie()
  let target = '/login'
  try {
    target = await getOidcClient().endSessionUrl()
  } catch {
    // OP unreachable: the console session is already gone, and /login will report the outage.
  }
  redirect(target)
}
