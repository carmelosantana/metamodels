import { describe, expect, test } from 'vitest'
import * as schema from '@metamodels/schema'
import { freshDb, seedOrg } from '../test/db'
import { loadActiveActor } from './actor'

async function withUser(overrides: Partial<{ status: string; role: string }> = {}) {
  const db = await freshDb()
  const org = await seedOrg(db)
  const [u] = await db.insert(schema.user).values({
    orgId: org.id, email: 'op@x.io', passwordHash: 'unused', role: overrides.role ?? 'member', status: overrides.status ?? 'active',
  }).returning()
  return { db, u, org }
}

describe('loadActiveActor', () => {
  test('maps an active user to an Actor', async () => {
    const { db, u, org } = await withUser()
    expect(await loadActiveActor(db, u.id)).toEqual({ id: u.id, orgId: org.id, email: 'op@x.io', role: 'member' })
  })

  test('refuses a deactivated user or an unknown role', async () => {
    const off = await withUser({ status: 'deactivated' })
    expect(await loadActiveActor(off.db, off.u.id)).toBeNull()
    const odd = await withUser({ role: 'owner' })
    expect(await loadActiveActor(odd.db, odd.u.id)).toBeNull()
  })

  test('refuses an unknown id and a non-uuid id without a database error', async () => {
    const { db } = await withUser()
    expect(await loadActiveActor(db, '00000000-0000-4000-8000-000000000000')).toBeNull()
    expect(await loadActiveActor(db, 'not-a-uuid')).toBeNull()
  })
})
