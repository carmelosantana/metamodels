import { describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '@metamodels/schema'
import type { Actor } from '../auth/authorize'
import { freshDb, seedOrg } from '../test/db'
import { writeAudit } from './audit'

describe('writeAudit', () => {
  test('persists an org-scoped audit row with actor/action/target/detail', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const actor: Actor = {
      id: 'u1', orgId: o.id, email: 'admin@x.io', role: 'admin', credential: 'session',
    }
    await writeAudit(db, actor, {
      action: 'flock.create', target: 'flock:123', detail: { name: 'local-ollama' },
    })
    const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, o.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor: 'admin@x.io', action: 'flock.create', target: 'flock:123' })
    expect(rows[0].detail).toMatchObject({ name: 'local-ollama' })
  })

  test('derives orgId, actor and changed_by from one Actor', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const actor: Actor = {
      id: 'u1', orgId: o.id, email: 'op@x.test', role: 'admin',
      credential: 'token:metamodels-cli:abc123',
    }
    await writeAudit(db, actor, { action: 'flock.create', target: 'flock:f1', detail: { name: 'n' } })

    const [row] = await db.select().from(schema.auditLog)
    expect(row.orgId).toBe(o.id)
    expect(row.actor).toBe('op@x.test')
    expect(row.changedBy).toBe('token:metamodels-cli:abc123')
  })

  test('the console session path records `session`', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    const actor: Actor = {
      id: 'u1', orgId: o.id, email: 'op@x.test', role: 'admin', credential: 'session',
    }
    await writeAudit(db, actor, { action: 'flock.delete', target: 'flock:f1' })
    const [row] = await db.select().from(schema.auditLog)
    expect(row.changedBy).toBe('session')
  })
})
