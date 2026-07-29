import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { and, count, eq } from 'drizzle-orm'
import { org, user } from '@metamodels/schema'
import { PG_TEST_URL, makeRealPgDb, uniqueEmail, uniqueName } from '../test/real-pg'
import { inviteUser, SeatLimitError } from './invites-service'
import { setUserStatus } from './users-service'
import type { Actor } from '../auth/authorize'
import type { Db } from './db'

// A concurrency test needs REAL, MULTIPLE Postgres connections: two transactions must be able to
// run at once so a missing FOR UPDATE lock would let both read a stale count. pglite (single
// connection) serializes at the driver and would hide the bug — hence PG_TEST_URL only.
describe.skipIf(!PG_TEST_URL)('acquireOrgLock under real concurrency', () => {
  let db: Db
  let close: () => Promise<void>
  beforeAll(async () => {
    ;({ db, close } = await makeRealPgDb())
  })
  afterAll(async () => {
    await close()
  })

  // Insert an org + an active admin; return the org id and an Actor for that admin.
  async function seedAdmin(): Promise<{ orgId: string; actor: Actor }> {
    const [o] = await db.insert(org).values({ name: uniqueName() }).returning()
    const email = uniqueEmail('admin')
    const [u] = await db
      .insert(user)
      .values({ orgId: o.id, email, role: 'admin', status: 'active', passwordHash: 'x' })
      .returning()
    return { orgId: o.id, actor: { id: u.id, orgId: o.id, email, role: 'admin' } }
  }

  async function activeAdminCount(orgId: string): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(user)
      .where(and(eq(user.orgId, orgId), eq(user.role, 'admin'), eq(user.status, 'active')))
    return row?.n ?? 0
  }

  test('two concurrent invites at the last free seat → exactly one succeeds', async () => {
    const { actor } = await seedAdmin() // 1 active admin fills 1 of 2 seats
    const now = Date.now()
    const seatLimit = 2
    // Two DIFFERENT emails so DuplicateInviteError never fires — both compete for the one free seat.
    const results = await Promise.allSettled([
      inviteUser(db, actor, { email: uniqueEmail('a'), role: 'member' }, seatLimit, now),
      inviteUser(db, actor, { email: uniqueEmail('b'), role: 'member' }, seatLimit, now),
    ])
    const ok = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(ok).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(SeatLimitError)
  })

  test('two concurrent last-two-admin deactivations → org keeps ≥1 admin', async () => {
    // Seed an org with exactly TWO active admins, each acting to deactivate the other.
    const [o] = await db.insert(org).values({ name: uniqueName() }).returning()
    const emailA = uniqueEmail('adminA')
    const emailB = uniqueEmail('adminB')
    const [a] = await db.insert(user).values({ orgId: o.id, email: emailA, role: 'admin', status: 'active', passwordHash: 'x' }).returning()
    const [b] = await db.insert(user).values({ orgId: o.id, email: emailB, role: 'admin', status: 'active', passwordHash: 'x' }).returning()
    const actorA: Actor = { id: a.id, orgId: o.id, email: emailA, role: 'admin' }
    const actorB: Actor = { id: b.id, orgId: o.id, email: emailB, role: 'admin' }
    const now = Date.now()
    const seatLimit = 5 // deactivation ignores seats; a high limit keeps the seat guard out of the way

    const results = await Promise.allSettled([
      setUserStatus(db, actorA, b.id, 'deactivated', seatLimit, now), // A deactivates B
      setUserStatus(db, actorB, a.id, 'deactivated', seatLimit, now), // B deactivates A
    ])
    const ok = results.filter((r) => r.status === 'fulfilled')
    // Exactly one deactivation wins; the other is rejected (LastAdminError, or NotFoundError if the
    // acting user was itself deactivated by the winner first). Either way the org must keep an admin.
    expect(ok).toHaveLength(1)
    expect(await activeAdminCount(o.id)).toBe(1)
  })
})
