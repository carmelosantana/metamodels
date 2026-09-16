import { NextResponse, type NextRequest } from 'next/server'
import { newTransaction } from '../../auth/oidc-client'
import { getOidcClient, setTransactionCookie } from '../../server/oidc-session'

export const dynamic = 'force-dynamic'

/** Start sign-in: mint a transaction, seal it into a cookie, send the browser to the OP. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  let target: string
  try {
    const tx = newTransaction()
    target = await getOidcClient().authorizationUrl(tx, req.nextUrl.searchParams.get('login_hint') ?? undefined)
    await setTransactionCookie(tx)
  } catch {
    // OP unreachable or console misconfigured. Show a page — never loop back into /login.
    return NextResponse.redirect(new URL('/auth/error?reason=unavailable', req.url), 303)
  }
  return NextResponse.redirect(target, 303)
}
