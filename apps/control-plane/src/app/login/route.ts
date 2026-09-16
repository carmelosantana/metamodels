import { NextResponse, type NextRequest } from 'next/server'
import { newTransaction, type OidcClient } from '../../auth/oidc-client'
import { sessionSecret } from '../../server/current-user'
import { getOidcClient, setTransactionCookie } from '../../server/oidc-session'
import { logSignInFailure, type SignInErrorReason } from '../../server/sign-in'

export const dynamic = 'force-dynamic'

function errorPage(reason: SignInErrorReason, base: string): NextResponse {
  // Show a page — never loop back into /login.
  return NextResponse.redirect(new URL(`/auth/error?reason=${reason}`, base), 303)
}

/** Start sign-in: mint a transaction, seal it into a cookie, send the browser to the OP. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  let client: OidcClient
  try {
    // Configuration first: a throw here is the console's own settings, not the auth service.
    sessionSecret()
    client = getOidcClient()
  } catch (err) {
    logSignInFailure(console.error, 'misconfigured', err)
    // No CONSOLE_URL to build on, so req.url is the only base left.
    return errorPage('misconfigured', req.url)
  }

  let target: string
  try {
    const tx = newTransaction()
    target = await client.authorizationUrl(tx, req.nextUrl.searchParams.get('login_hint') ?? undefined)
    await setTransactionCookie(tx)
  } catch (err) {
    logSignInFailure(console.error, 'unavailable', err)
    // Absolute URLs from CONSOLE_URL: behind a proxy or tunnel, req.url is the container's own address.
    return errorPage('unavailable', client.cfg.consoleUrl)
  }
  return NextResponse.redirect(target, 303)
}
