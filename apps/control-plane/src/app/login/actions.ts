'use server'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getDb } from '../../server/db'
import { verifyLogin } from '../../server/auth-service'
import { setSessionCookie, clearSessionCookie } from '../../server/current-user'
import { LoginThrottle } from '../../auth/login-throttle'

// Module-scoped throttle (per server instance). Good enough for a self-hosted single node.
const throttle = new LoginThrottle()

export async function login(_prev: unknown, formData: FormData): Promise<{ error?: string }> {
  const email = String(formData.get('email') ?? '').trim()
  const password = String(formData.get('password') ?? '')
  const ip = (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local'
  const now = Date.now()

  if (!throttle.check(ip, now)) return { error: 'Too many attempts. Try again later.' }

  const result = await verifyLogin(getDb(), email, password)
  if (!result.ok) {
    throttle.record(ip, now)
    return { error: result.reason === 'deactivated' ? 'This account is deactivated.' : 'Invalid email or password.' }
  }
  await setSessionCookie(result.actor)
  // Best-effort license re-validation on login (offline grace covers any failure). Never blocks login.
  try {
    if (process.env.LICENSE_KEY_SECRET) {
      const { revalidateLicense } = await import('../../server/license-service')
      const { LemonSqueezyClient } = await import('../../server/ls-client')
      await revalidateLicense(getDb(), result.actor.orgId, {
        ls: new LemonSqueezyClient(), secret: process.env.LICENSE_KEY_SECRET, nowMs: Date.now(),
      })
    }
  } catch {
    // ignore — login must never fail on license revalidation
  }
  redirect('/')
}

export async function logout(): Promise<void> {
  await clearSessionCookie()
  redirect('/login')
}
