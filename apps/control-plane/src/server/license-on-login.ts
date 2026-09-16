import { getDb } from './db'

/** Best-effort licence re-validation after sign-in. Never throws: sign-in must not fail on licensing. */
export async function revalidateLicenseOnLogin(orgId: string): Promise<void> {
  try {
    if (!process.env.LICENSE_KEY_SECRET) return
    const { revalidateLicense } = await import('./license-service')
    const { LemonSqueezyClient } = await import('./ls-client')
    await revalidateLicense(getDb(), orgId, {
      ls: new LemonSqueezyClient(), secret: process.env.LICENSE_KEY_SECRET, nowMs: Date.now(),
    })
  } catch {
    // ignore — offline grace covers any failure
  }
}
