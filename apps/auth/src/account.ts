import { eq } from 'drizzle-orm'
import { USER_ROLES, user, verifyPassword } from '@metamodels/schema'
import type { Account, FindAccount } from 'oidc-provider'
import type { Db } from './db.js'

/**
 * A fixed, well-formed scrypt hash used ONLY to spend equivalent KDF time on the
 * unknown-email path, so login latency does not reveal whether an email exists.
 * The value is a throwaway — it never matches any real password.
 */
export const DUMMY_PASSWORD_HASH =
  'scrypt$6d081b91a6b7f71ca147f3f40fbaa91e$1b55a743a37ee80e7baf5d576b88b02c1e8bb5c1f8af173265829ea33c7df0582caa90bc1ad236c3e5be2e9a47c15462f2397cd59cc498cdb1c4c2960d4b84d8'

export type LoginResult =
  | { ok: true; accountId: string }
  | { ok: false; reason: 'invalid' | 'deactivated' }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isKnownRole(role: string): boolean {
  return (USER_ROLES as readonly string[]).includes(role)
}

export async function verifyLogin(db: Db, email: string, password: string): Promise<LoginResult> {
  const rows = await db.select().from(user).where(eq(user.email, email)).limit(1)
  const u = rows[0]
  if (!u) {
    // Spend equivalent scrypt time so an unknown email is timing-indistinguishable
    // from a known email with a wrong password. Result is intentionally discarded.
    await verifyPassword(password, DUMMY_PASSWORD_HASH)
    return { ok: false, reason: 'invalid' }
  }
  const passwordOk = await verifyPassword(password, u.passwordHash)
  if (!passwordOk) return { ok: false, reason: 'invalid' }
  if (u.status !== 'active') return { ok: false, reason: 'deactivated' }
  if (!isKnownRole(u.role)) return { ok: false, reason: 'invalid' }
  return { ok: true, accountId: u.id }
}

/**
 * oidc-provider's account lookup. Re-reads the user on every call, so deactivating a user ends
 * their ability to obtain new tokens immediately. Releases only `sub`: the console and resource
 * servers load everything else (org, role, email) from the database by that id.
 */
export function makeFindAccount(db: Db): FindAccount {
  return async (_ctx, sub) => {
    if (!UUID.test(sub)) return undefined
    const rows = await db.select({ id: user.id, status: user.status }).from(user).where(eq(user.id, sub)).limit(1)
    const u = rows[0]
    if (!u || u.status !== 'active') return undefined
    const account: Account = { accountId: u.id, claims: () => ({ sub: u.id }) }
    return account
  }
}
