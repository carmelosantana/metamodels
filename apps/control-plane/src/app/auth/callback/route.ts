import { NextResponse, type NextRequest } from 'next/server'
import type { OidcClient } from '../../../auth/oidc-client'
import { loadActiveActor } from '../../../server/actor'
import { sessionSecret, setSessionCookie } from '../../../server/current-user'
import { getDb } from '../../../server/db'
import { revalidateLicenseOnLogin } from '../../../server/license-on-login'
import { getOidcClient, takeTransactionCookie } from '../../../server/oidc-session'
import { completeSignIn, logSignInFailure } from '../../../server/sign-in'

export const dynamic = 'force-dynamic'

/** The OP's redirect target. Everything that can reject lives in completeSignIn. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  let client: OidcClient
  try {
    sessionSecret()
    client = getOidcClient()
  } catch (err) {
    logSignInFailure(console.error, 'misconfigured', err)
    // Config did not load, so there is no CONSOLE_URL: req.url is the only base left.
    return NextResponse.redirect(new URL('/auth/error?reason=misconfigured', req.url), 303)
  }
  const tx = await takeTransactionCookie()
  const result = await completeSignIn(req.nextUrl.searchParams, tx, {
    issuer: client.cfg.issuer,
    exchangeCode: (code, t) => client.exchangeCode(code, t),
    loadActor: (sub) => loadActiveActor(getDb(), sub, 'session'),
    log: console.error,
  })
  // Absolute URLs from CONSOLE_URL: behind a proxy or tunnel, req.url is the container's own address.
  if (!result.ok) {
    return NextResponse.redirect(new URL(`/auth/error?reason=${result.reason}`, client.cfg.consoleUrl), 303)
  }
  await setSessionCookie(result.actor)
  await revalidateLicenseOnLogin(result.actor.orgId)
  return NextResponse.redirect(new URL('/', client.cfg.consoleUrl), 303)
}
