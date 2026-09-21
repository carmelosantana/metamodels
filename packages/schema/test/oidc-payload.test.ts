import { describe, expect, test } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { and, eq } from 'drizzle-orm'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as schema from '../src/schema.js'

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../drizzle')

async function freshDb() {
  const db = drizzle(new PGlite(), { schema })
  await migrate(db, { migrationsFolder })
  return db
}

describe('oidc_payload', () => {
  test('stores a payload keyed by (model, id) with nullable lookup and lifecycle columns', async () => {
    const db = await freshDb()
    await db.insert(schema.oidcPayload).values({ model: 'Session', id: 'abc', payload: { kind: 'Session' }, uid: 'u-1' })
    const rows = await db
      .select()
      .from(schema.oidcPayload)
      .where(and(eq(schema.oidcPayload.model, 'Session'), eq(schema.oidcPayload.id, 'abc')))
    expect(rows).toHaveLength(1)
    expect(rows[0].payload).toEqual({ kind: 'Session' })
    expect(rows[0].uid).toBe('u-1')
    expect(rows[0].grantId).toBeNull()
    expect(rows[0].expiresAt).toBeNull()
    expect(rows[0].consumedAt).toBeNull()
  })

  test('the same id may exist under two different models', async () => {
    const db = await freshDb()
    await db.insert(schema.oidcPayload).values({ model: 'Session', id: 'same', payload: {} })
    await db.insert(schema.oidcPayload).values({ model: 'AccessToken', id: 'same', payload: {} })
    expect(await db.select().from(schema.oidcPayload)).toHaveLength(2)
  })

  test('a duplicate (model, id) is rejected by the primary key', async () => {
    const db = await freshDb()
    await db.insert(schema.oidcPayload).values({ model: 'Grant', id: 'g1', payload: {} })
    await expect(db.insert(schema.oidcPayload).values({ model: 'Grant', id: 'g1', payload: {} })).rejects.toThrow()
  })
})
