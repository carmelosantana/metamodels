import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as schema from '@metamodels/schema'
import { hashPassword } from '@metamodels/schema'

export type TestDb = ReturnType<typeof drizzle<typeof schema>>

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../packages/schema/drizzle')

export async function makeDb(): Promise<TestDb> {
  const db = drizzle(new PGlite(), { schema })
  await migrate(db, { migrationsFolder })
  return db
}

/** Insert an org and a user with a real scrypt hash. Returns the user id (the OIDC `sub`). */
export async function seedUser(
  db: TestDb,
  opts: { email: string; password: string; status?: string; role?: string },
): Promise<string> {
  const [org] = await db.insert(schema.org).values({ name: `org-${opts.email}` }).returning()
  const [u] = await db.insert(schema.user).values({
    orgId: org.id,
    email: opts.email,
    passwordHash: await hashPassword(opts.password),
    role: opts.role ?? 'admin',
    status: opts.status ?? 'active',
  }).returning()
  return u.id
}
