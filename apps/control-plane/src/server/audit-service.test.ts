import { describe, expect, test } from 'vitest'
import * as schema from '@metamodels/schema'
import { freshDb, seedOrg, type TestDb } from '../test/db'
import { listAudit, auditFilterOptions } from './audit-service'
import { ForbiddenError, type Actor } from '../auth/authorize'

async function actorFor(db: TestDb, role: Actor['role']): Promise<Actor> {
  const o = await seedOrg(db)
  return { id: 'u1', orgId: o.id, email: `${role}@x.io`, role }
}

async function seedAudit(db: TestDb, orgId: string, actor: string, action: string, target: string, detail?: unknown) {
  await db.insert(schema.auditLog).values({ orgId, actor, action, target, detail: (detail ?? null) as never })
}

describe('audit-service', () => {
  test('listAudit returns this org newest-first, honoring limit', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    await seedAudit(db, actor.orgId, 'carmelo@x.io', 'flock.create', 'flock:1')
    await seedAudit(db, actor.orgId, 'carmelo@x.io', 'key.create', 'key:2', { name: 'Acme' })
    await seedAudit(db, actor.orgId, 'carmelo@x.io', 'key.revoke', 'key:2')

    const rows = await listAudit(db, actor, { limit: 2 })
    expect(rows).toHaveLength(2)
    expect(rows[0].action).toBe('key.revoke') // newest first
    expect(rows[1].action).toBe('key.create')
    expect(rows[1].detail).toEqual({ name: 'Acme' })
  })

  test('listAudit is org-scoped (no cross-org leak) and filters by action + actor', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    await seedAudit(db, actor.orgId, 'carmelo@x.io', 'flock.create', 'flock:1')
    await seedAudit(db, actor.orgId, 'jo@x.io', 'key.create', 'key:2')
    const [other] = await db.insert(schema.org).values({ name: 'other' }).returning()
    await seedAudit(db, other.id, 'spy@x.io', 'flock.create', 'flock:9')

    expect(await listAudit(db, actor, { limit: 50 })).toHaveLength(2) // not the foreign row
    const byAction = await listAudit(db, actor, { limit: 50, action: 'key.create' })
    expect(byAction.map((r) => r.action)).toEqual(['key.create'])
    const byActor = await listAudit(db, actor, { limit: 50, auditActor: 'jo@x.io' })
    expect(byActor.map((r) => r.actor)).toEqual(['jo@x.io'])
  })

  test('auditFilterOptions returns distinct sorted actions + actors for this org', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'admin')
    await seedAudit(db, actor.orgId, 'carmelo@x.io', 'key.revoke', 'key:2')
    await seedAudit(db, actor.orgId, 'carmelo@x.io', 'flock.create', 'flock:1')
    await seedAudit(db, actor.orgId, 'jo@x.io', 'flock.create', 'flock:3')
    const [other] = await db.insert(schema.org).values({ name: 'other' }).returning()
    await seedAudit(db, other.id, 'spy@x.io', 'paddock.create', 'paddock:9')

    const opts = await auditFilterOptions(db, actor)
    expect(opts.actions).toEqual(['flock.create', 'key.revoke'])
    expect(opts.actors).toEqual(['carmelo@x.io', 'jo@x.io'])
  })

  test('viewer can read the audit log', async () => {
    const db = await freshDb()
    const actor = await actorFor(db, 'viewer')
    await seedAudit(db, actor.orgId, 'carmelo@x.io', 'flock.create', 'flock:1')
    expect(await listAudit(db, actor, { limit: 10 })).toHaveLength(1)
  })

  test('a non-read role is rejected', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const noRead = { id: 'u1', orgId: o.id, email: 'x@x.io', role: 'viewer' as const }
    // sanity: viewer HAS read; assert the capability gate exists by calling requireCapability path via a bad role cast
    const bad = { ...noRead, role: 'nobody' as unknown as Actor['role'] }
    await expect(listAudit(db, bad, { limit: 10 })).rejects.toThrow(ForbiddenError)
  })
})
