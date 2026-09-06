import { eq } from 'drizzle-orm'
import { org, user } from '@metamodels/schema'
import type { Db } from './db'
import type { Actor } from '../auth/authorize'
import { hashPassword } from '../auth/password'

export interface SeedOpts { email: string; password: string; orgName?: string }
export interface SeedResult { created: boolean; actor: Actor }

/** The email already belongs to a user who is not an admin — seeding cannot vouch for them. */
export class NotAdminError extends Error {
  readonly email: string
  constructor(email: string, role: string) {
    super(`user ${email} already exists with role '${role}', not 'admin'`)
    this.name = 'NotAdminError'
    this.email = email
  }
}

export async function seedAdmin(db: Db, opts: SeedOpts): Promise<SeedResult> {
  const existing = await db.select().from(user).where(eq(user.email, opts.email)).limit(1)
  if (existing[0]) {
    const u = existing[0]
    if (u.role !== 'admin') throw new NotAdminError(u.email, u.role)
    return { created: false, actor: { id: u.id, orgId: u.orgId, email: u.email, role: u.role } }
  }
  // Reuse an existing org (single-org instance) or create one.
  const orgs = await db.select().from(org).limit(1)
  const orgId = orgs[0]?.id ?? (await db.insert(org).values({ name: opts.orgName ?? 'default' }).returning())[0].id
  const passwordHash = await hashPassword(opts.password)
  const [u] = await db.insert(user).values({
    orgId, email: opts.email, passwordHash, role: 'admin', status: 'active',
  }).returning()
  return { created: true, actor: { id: u.id, orgId: u.orgId, email: u.email, role: 'admin' } }
}
