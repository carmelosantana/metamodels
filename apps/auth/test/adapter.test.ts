import { describe, expect, test } from 'vitest'
import { PgAdapter, pgAdapterFactory, sweepExpired } from '../src/adapter.js'
import { makeDb } from './helpers/db.js'

function clock(start = Date.UTC(2026, 0, 1)) {
  let t = start
  return { now: () => new Date(t), advance: (seconds: number) => { t += seconds * 1000 } }
}

describe('PgAdapter', () => {
  test('find returns exactly what upsert stored', async () => {
    const db = await makeDb()
    const a = new PgAdapter(db, 'Session')
    await a.upsert('s1', { kind: 'Session', uid: 'u1', accountId: 'acct-1' }, 60)
    expect(await a.find('s1')).toEqual({ kind: 'Session', uid: 'u1', accountId: 'acct-1' })
  })

  test('models are isolated: the same id under another model is not found', async () => {
    const db = await makeDb()
    await new PgAdapter(db, 'Session').upsert('x', { kind: 'Session' }, 60)
    expect(await new PgAdapter(db, 'AccessToken').find('x')).toBeUndefined()
  })

  test('upsert overwrites the payload for an existing id', async () => {
    const db = await makeDb()
    const a = new PgAdapter(db, 'Session')
    await a.upsert('s1', { kind: 'Session', accountId: 'old' }, 60)
    await a.upsert('s1', { kind: 'Session', accountId: 'new' }, 60)
    expect(await a.find('s1')).toEqual({ kind: 'Session', accountId: 'new' })
  })

  test('a row past its expiry is invisible', async () => {
    const db = await makeDb()
    const c = clock()
    const a = pgAdapterFactory(db, c.now)('AccessToken')
    await a.upsert('t1', { kind: 'AccessToken' }, 10)
    c.advance(9)
    expect(await a.find('t1')).toBeDefined()
    c.advance(2)
    expect(await a.find('t1')).toBeUndefined()
  })

  test('without expiresIn a row never expires', async () => {
    const db = await makeDb()
    const c = clock()
    const a = new PgAdapter(db, 'Grant', c.now)
    await a.upsert('g1', { kind: 'Grant' })
    c.advance(10 * 365 * 24 * 3600)
    expect(await a.find('g1')).toEqual({ kind: 'Grant' })
  })

  test('consume marks the row consumed without removing it', async () => {
    const db = await makeDb()
    const a = new PgAdapter(db, 'AuthorizationCode')
    await a.upsert('c1', { kind: 'AuthorizationCode' }, 60)
    await a.consume('c1')
    const found = await a.find('c1')
    expect(found).toMatchObject({ kind: 'AuthorizationCode' })
    expect(found && found.consumed).toBeTruthy()
  })

  test('destroy removes the row', async () => {
    const db = await makeDb()
    const a = new PgAdapter(db, 'Session')
    await a.upsert('s1', { kind: 'Session' }, 60)
    await a.destroy('s1')
    expect(await a.find('s1')).toBeUndefined()
  })

  test('findByUid and findByUserCode use their lookup columns', async () => {
    const db = await makeDb()
    const sessions = new PgAdapter(db, 'Session')
    const devices = new PgAdapter(db, 'DeviceCode')
    await sessions.upsert('s1', { kind: 'Session', uid: 'uid-1' }, 60)
    await devices.upsert('d1', { kind: 'DeviceCode', userCode: 'ABCD-EFGH' }, 60)
    expect(await sessions.findByUid('uid-1')).toMatchObject({ uid: 'uid-1' })
    expect(await devices.findByUserCode('ABCD-EFGH')).toMatchObject({ userCode: 'ABCD-EFGH' })
    expect(await sessions.findByUid('nope')).toBeUndefined()
  })

  test('revokeByGrantId removes this model\'s rows for that grant and nothing else', async () => {
    const db = await makeDb()
    const at = new PgAdapter(db, 'AccessToken')
    const rt = new PgAdapter(db, 'RefreshToken')
    await at.upsert('a1', { kind: 'AccessToken', grantId: 'g1' }, 60)
    await at.upsert('a2', { kind: 'AccessToken', grantId: 'g1' }, 60)
    await at.upsert('a3', { kind: 'AccessToken', grantId: 'g2' }, 60)
    await rt.upsert('r1', { kind: 'RefreshToken', grantId: 'g1' }, 60)
    await at.revokeByGrantId('g1')
    expect(await at.find('a1')).toBeUndefined()
    expect(await at.find('a2')).toBeUndefined()
    expect(await at.find('a3')).toBeDefined()
    expect(await rt.find('r1')).toBeDefined()
  })
})

describe('sweepExpired', () => {
  test('deletes only expired rows and reports how many', async () => {
    const db = await makeDb()
    const c = clock()
    const factory = pgAdapterFactory(db, c.now)
    await factory('AccessToken').upsert('old', { kind: 'AccessToken' }, 5)
    await factory('AccessToken').upsert('fresh', { kind: 'AccessToken' }, 3600)
    await factory('Grant').upsert('forever', { kind: 'Grant' })
    c.advance(10)
    expect(await sweepExpired(db, c.now())).toBe(1)
    expect(await factory('AccessToken').find('fresh')).toBeDefined()
    expect(await factory('Grant').find('forever')).toBeDefined()
  })
})
