import { describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import * as schema from '@metamodels/schema'
import { freshDb, seedOrg } from '../test/db'
import { writeAudit } from './audit'

describe('writeAudit', () => {
  test('persists an org-scoped audit row with actor/action/target/detail', async () => {
    const db = await freshDb()
    const o = await seedOrg(db)
    await writeAudit(db, {
      orgId: o.id, actor: 'admin@x.io', action: 'flock.create',
      target: 'flock:123', detail: { name: 'local-ollama' },
    })
    const rows = await db.select().from(schema.auditLog).where(eq(schema.auditLog.orgId, o.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor: 'admin@x.io', action: 'flock.create', target: 'flock:123' })
    expect(rows[0].detail).toMatchObject({ name: 'local-ollama' })
  })
})
