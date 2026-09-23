import {
  deleteCredentials, readCredentials, withCredentialsLock, writeCredentials, type LockOptions, type StoredCredential,
} from './credentials.js'
import { refresh, SignInAgainError, type OpDeps } from './device.js'

export interface SessionContext {
  /** The credentials file. */
  path: string
  issuer: string
  /** The admin-API resource the configured console serves. */
  resource: string
  deps?: OpDeps
  lock?: LockOptions
}

/**
 * The stored credential for this issuer. Refuses one bound to a different resource before anything
 * is sent with it: its access token would be rejected, and the refresh that follows would name a
 * resource the OP refuses — spending the refresh token on the way.
 */
export function loadCredential(ctx: SessionContext): StoredCredential {
  const cred = readCredentials(ctx.path, ctx.issuer)
  if (cred === null) throw new Error(`not signed in to ${ctx.issuer}; run \`mm login\``)
  if (cred.resource !== ctx.resource) {
    throw new Error(
      `the sign-in stored for ${ctx.issuer} is for ${cred.resource}, not ${ctx.resource}; ` +
      'check --console, or run `mm login` for this console',
    )
  }
  return cred
}

/**
 * Replace `stale` — a credential whose access token was just refused — with a refreshed one, under
 * the credentials lock so that concurrent `mm` processes present a refresh token at most once.
 *
 * After taking the lock it re-reads the store: if another process has refreshed in the meantime,
 * that result is used and nothing is sent. Otherwise one refresh; the rotated tokens are written
 * (atomically) before the lock is released. A refused refresh has spent its token, so the stored
 * credential is dropped rather than kept for a retry that would read as reuse and revoke the grant.
 */
export async function refreshStored(ctx: SessionContext, stale: StoredCredential): Promise<StoredCredential> {
  return withCredentialsLock(ctx.path, async () => {
    const current = readCredentials(ctx.path, ctx.issuer)
    if (current === null) throw new SignInAgainError(`no sign-in is stored for ${ctx.issuer}`)
    if (current.accessToken !== stale.accessToken) return current
    if (current.refreshToken === undefined) throw new SignInAgainError('the stored sign-in cannot be renewed')
    try {
      const next = await refresh({ issuer: ctx.issuer, resource: current.resource, refreshToken: current.refreshToken }, ctx.deps)
      writeCredentials(ctx.path, next)
      return next
    } catch (e) {
      if (e instanceof SignInAgainError) deleteCredentials(ctx.path, ctx.issuer)
      throw e
    }
  }, ctx.lock)
}
