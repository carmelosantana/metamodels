import { describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '@metamodels/schema'
import { freshDb } from '../test/db'
import { seedAdmin } from './seed'
import { verifyLogin } from './auth-service'

describe('verifyLogin', () => {
  test('accepts correct credentials for an active user', async () => {
    const db = await freshDb()
    await seedAdmin(db, { email: 'admin@x.io', password: 'hunter2hunter2' })
    const r = await verifyLogin(db, 'admin@x.io', 'hunter2hunter2')
    expect(r).toMatchObject({ ok: true })
    if (r.ok) expect(r.actor.email).toBe('admin@x.io')
  })

  test('rejects wrong password and unknown email as generic invalid', async () => {
    const db = await freshDb()
    await seedAdmin(db, { email: 'admin@x.io', password: 'hunter2hunter2' })
    expect(await verifyLogin(db, 'admin@x.io', 'nope')).toEqual({ ok: false, reason: 'invalid' })
    expect(await verifyLogin(db, 'ghost@x.io', 'whatever')).toEqual({ ok: false, reason: 'invalid' })
  })

  test('rejects a deactivated user distinctly', async () => {
    const db = await freshDb()
    await seedAdmin(db, { email: 'admin@x.io', password: 'hunter2hunter2' })
    await db.update(schema.user).set({ status: 'deactivated' }).where(eq(schema.user.email, 'admin@x.io'))
    expect(await verifyLogin(db, 'admin@x.io', 'hunter2hunter2')).toEqual({ ok: false, reason: 'deactivated' })
  })
})
