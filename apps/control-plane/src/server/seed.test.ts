import { eq } from 'drizzle-orm'
import { describe, expect, test } from 'vitest'
import * as schema from '@metamodels/schema'
import { freshDb } from '../test/db'
import { NotAdminError, seedAdmin } from './seed'
import { verifyPassword } from '../auth/password'

describe('seedAdmin', () => {
  test('creates an org + active admin whose password verifies', async () => {
    const db = await freshDb()
    const r = await seedAdmin(db, { email: 'admin@x.io', password: 'hunter2hunter2', orgName: 'Acme' })
    expect(r.created).toBe(true)
    expect(r.actor.role).toBe('admin')
    const [u] = await db.select().from(schema.user)
    expect(u.status).toBe('active')
    expect(await verifyPassword('hunter2hunter2', u.passwordHash)).toBe(true)
  })

  test('is idempotent — second call does not create or mutate', async () => {
    const db = await freshDb()
    await seedAdmin(db, { email: 'admin@x.io', password: 'hunter2hunter2' })
    const r2 = await seedAdmin(db, { email: 'admin@x.io', password: 'DIFFERENT-pass' })
    expect(r2.created).toBe(false)
    const users = await db.select().from(schema.user)
    expect(users).toHaveLength(1)
    expect(await verifyPassword('hunter2hunter2', users[0].passwordHash)).toBe(true) // unchanged
  })

  test('refuses when the email belongs to an existing non-admin user', async () => {
    const db = await freshDb()
    await seedAdmin(db, { email: 'admin@x.io', password: 'hunter2hunter2' })
    const [o] = await db.select().from(schema.org)
    await db.insert(schema.user).values({
      orgId: o.id, email: 'member@x.io', passwordHash: 'x', role: 'member', status: 'active',
    })

    await expect(seedAdmin(db, { email: 'member@x.io', password: 'hunter2hunter2' })).rejects.toThrow(NotAdminError)

    const [m] = await db.select().from(schema.user).where(eq(schema.user.email, 'member@x.io'))
    expect(m.role).toBe('member') // untouched
  })
})
