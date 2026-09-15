import { describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '@metamodels/schema'
import { verifyPassword } from '@metamodels/schema'
import { DUMMY_PASSWORD_HASH, makeFindAccount, verifyLogin } from '../src/account.js'
import { makeDb, seedUser } from './helpers/db.js'

const ctx = {} as never // findAccount never reads ctx

describe('verifyLogin', () => {
  test('accepts correct credentials for an active user and returns the user id', async () => {
    const db = await makeDb()
    const id = await seedUser(db, { email: 'admin@x.io', password: 'hunter2hunter2' })
    expect(await verifyLogin(db, 'admin@x.io', 'hunter2hunter2')).toEqual({ ok: true, accountId: id })
  })

  test('rejects a wrong password and an unknown email identically', async () => {
    const db = await makeDb()
    await seedUser(db, { email: 'admin@x.io', password: 'hunter2hunter2' })
    expect(await verifyLogin(db, 'admin@x.io', 'nope')).toEqual({ ok: false, reason: 'invalid' })
    expect(await verifyLogin(db, 'ghost@x.io', 'whatever')).toEqual({ ok: false, reason: 'invalid' })
  })

  test('rejects a deactivated user distinctly — but only after the password checks out', async () => {
    const db = await makeDb()
    await seedUser(db, { email: 'admin@x.io', password: 'hunter2hunter2', status: 'deactivated' })
    expect(await verifyLogin(db, 'admin@x.io', 'hunter2hunter2')).toEqual({ ok: false, reason: 'deactivated' })
    expect(await verifyLogin(db, 'admin@x.io', 'wrong')).toEqual({ ok: false, reason: 'invalid' })
  })

  test('treats an unrecognised role as invalid', async () => {
    const db = await makeDb()
    await seedUser(db, { email: 'odd@x.io', password: 'hunter2hunter2', role: 'owner' })
    expect(await verifyLogin(db, 'odd@x.io', 'hunter2hunter2')).toEqual({ ok: false, reason: 'invalid' })
  })

  test('DUMMY_PASSWORD_HASH is a well-formed scrypt hash the KDF actually processes', async () => {
    expect(DUMMY_PASSWORD_HASH).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/)
    expect(await verifyPassword('anything', DUMMY_PASSWORD_HASH)).toBe(false)
  })
})

describe('makeFindAccount', () => {
  test('finds an active user and releases only the sub claim', async () => {
    const db = await makeDb()
    const id = await seedUser(db, { email: 'a@x.io', password: 'hunter2hunter2' })
    const account = await makeFindAccount(db)(ctx, id)
    expect(account?.accountId).toBe(id)
    expect(await account!.claims('id_token', 'openid', {}, [])).toEqual({ sub: id })
  })

  test('returns undefined for a deactivated user, so existing sessions stop working', async () => {
    const db = await makeDb()
    const id = await seedUser(db, { email: 'a@x.io', password: 'hunter2hunter2' })
    await db.update(schema.user).set({ status: 'deactivated' }).where(eq(schema.user.id, id))
    expect(await makeFindAccount(db)(ctx, id)).toBeUndefined()
  })

  test('returns undefined for an unknown id and for a non-uuid id without querying badly', async () => {
    const db = await makeDb()
    expect(await makeFindAccount(db)(ctx, '00000000-0000-4000-8000-000000000000')).toBeUndefined()
    expect(await makeFindAccount(db)(ctx, 'not-a-uuid')).toBeUndefined()
  })
})
