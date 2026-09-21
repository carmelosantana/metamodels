import { cookies } from 'next/headers'
import { loadOidcClientConfig, OidcClient, parseTransaction, type AuthTransaction } from '../auth/oidc-client'
import { openJson, sealJson } from '../auth/session'
import { sessionSecret } from './current-user'

export const TX_COOKIE = 'mm_oidc_tx'
const TX_TTL_MS = 10 * 60 * 1000
const TX_PATH = '/auth/callback'

let client: OidcClient | undefined

/** One client per process, so discovery and the JWKS are cached across requests. */
export function getOidcClient(): OidcClient {
  client ??= new OidcClient(loadOidcClientConfig())
  return client
}

export async function setTransactionCookie(tx: AuthTransaction): Promise<void> {
  ;(await cookies()).set(TX_COOKIE, sealJson({ ...tx }, sessionSecret(), TX_TTL_MS, Date.now()), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    // Lax, not Strict: the OP's redirect back is a cross-site top-level GET, which Lax still sends.
    sameSite: 'lax',
    path: TX_PATH,
    maxAge: TX_TTL_MS / 1000,
  })
}

/** Read AND delete the transaction: one attempt per sign-in, never replayable. */
export async function takeTransactionCookie(): Promise<AuthTransaction | null> {
  const jar = await cookies()
  const raw = jar.get(TX_COOKIE)?.value
  jar.delete({ name: TX_COOKIE, path: TX_PATH })
  if (!raw) return null
  // parseTransaction validates every field: what comes back from the seal is Record<string, unknown>,
  // and exchangeCode's nonce guard depends on never being handed an absent or empty one.
  return parseTransaction(openJson(raw, sessionSecret(), Date.now()))
}
