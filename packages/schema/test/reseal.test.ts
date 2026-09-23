import { randomBytes, randomUUID } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { eq, sql } from 'drizzle-orm'
import { describe, expect, test } from 'vitest'
import * as schema from '../src/schema.js'
import { loadSealKeyring, openSealed, seal, type SealBinding, type SealKeyring } from '../src/sealed.js'
import { resealUpstreamAuth } from '../src/reseal.js'

const { flock, org } = schema
const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../drizzle')
const key = () => randomBytes(32).toString('base64')
const ring = (cur: string, prev: string[] = []): SealKeyring =>
  loadSealKeyring({ UPSTREAM_AUTH_KEY: cur, UPSTREAM_AUTH_PREVIOUS_KEYS: prev.join(',') })

/** The migrations folder as it stood at `lastIdx`, so a test can hold a database at an old schema. */
function foldersUpTo(lastIdx: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'mm-migrations-'))
  cpSync(migrationsFolder, dir, { recursive: true })
  const journalPath = join(dir, 'meta/_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] }
  journal.entries = journal.entries.filter((e) => e.idx <= lastIdx)
  writeFileSync(journalPath, JSON.stringify(journal))
  return dir
}

async function migratedDb() {
  const db = drizzle(new PGlite(), { schema })
  await migrate(db, { migrationsFolder })
  const [o] = await db.insert(org).values({ name: 'o' }).returning()
  return { db, orgId: o.id }
}

/** A flock whose credential is built for its own row: `make` gets the ids it will be stored under. */
const addFlock = (
  db: Awaited<ReturnType<typeof migratedDb>>['db'], orgId: string, name: string,
  make: ((bind: SealBinding) => string) | null,
) => {
  const id = randomUUID()
  return db.insert(flock).values({ id, orgId, breed: 'ollama', name, baseUrl: 'http://o', upstreamAuthEnc: make ? make({ orgId, flockId: id }) : null })
    .returning().then((r) => r[0])
}
const bindOf = (row: { id: string; orgId: string }): SealBinding => ({ orgId: row.orgId, flockId: row.id })

describe('migration 0008 + resealUpstreamAuth — the upgrade path', () => {
  test('a pre-0008 plaintext credential survives the rename and comes out sealed, then the check is validated', async () => {
    const db = drizzle(new PGlite(), { schema })
    await migrate(db, { migrationsFolder: foldersUpTo(7) })
    const [{ id: orgId }] = (await db.execute(sql`insert into "org" (name) values ('o') returning id`)).rows as { id: string }[]
    await db.execute(sql`insert into "flock" (org_id, breed, name, base_url, upstream_auth)
      values (${orgId}, 'ollama', 'legacy', 'http://o', 'Bearer legacy-token')`)

    await migrate(db, { migrationsFolder })
    // NOT VALID let the plaintext through the migration — the positive anchor for "sealed" below.
    const [before] = await db.select().from(flock)
    expect(before.upstreamAuthEnc).toBe('Bearer legacy-token')

    const r = ring(key())
    const report = await resealUpstreamAuth(db, r)
    expect(report).toEqual({ sealed: 1, resealed: 0, unreadable: [], vacuum: 'done' })
    const [after] = await db.select().from(flock)
    expect(after.upstreamAuthEnc).not.toContain('legacy-token')
    expect(openSealed(after.upstreamAuthEnc!, r, bindOf(after))).toBe('Bearer legacy-token')

    const { rows } = await db.execute(sql`select convalidated from pg_constraint where conname = 'flock_upstream_auth_sealed'`)
    expect(rows).toEqual([{ convalidated: true }])
  })

  test('sealing plaintext rewrites the table, so the old row versions holding it are not left in its pages', async () => {
    const db = drizzle(new PGlite(), { schema })
    await migrate(db, { migrationsFolder: foldersUpTo(7) })
    const [{ id: orgId }] = (await db.execute(sql`insert into "org" (name) values ('o') returning id`)).rows as { id: string }[]
    await db.execute(sql`insert into "flock" (org_id, breed, name, base_url, upstream_auth)
      values (${orgId}, 'ollama', 'legacy', 'http://o', 'Bearer legacy-token')`)
    await migrate(db, { migrationsFolder })
    const filenode = async () =>
      ((await db.execute(sql`select pg_relation_filenode('flock') as n`)).rows[0] as { n: number }).n
    const before = await filenode()
    await resealUpstreamAuth(db, ring(key()))
    // VACUUM FULL writes a new relation file; a plain UPDATE only adds row versions beside the old.
    expect(await filenode()).not.toBe(before)
  })

  test('a pass with no plaintext to seal does not rewrite the table', async () => {
    const { db } = await migratedDb()
    const filenode = async () =>
      ((await db.execute(sql`select pg_relation_filenode('flock') as n`)).rows[0] as { n: number }).n
    const before = await filenode()
    await resealUpstreamAuth(db, ring(key()))
    expect(await filenode()).toBe(before)
  })
})

describe('resealUpstreamAuth', () => {
  test('the database refuses a plaintext write once migrated', async () => {
    const { db, orgId } = await migratedDb()
    const err = await addFlock(db, orgId, 'f', () => 'plain-token').catch((e: Error) => e)
    // Drizzle wraps the driver error; the constraint name is on the cause.
    expect(String((err as Error & { cause?: unknown }).cause ?? err)).toMatch(/flock_upstream_auth_sealed/)
  })

  test('re-seals rows under a previous key with the current one — how a rotation completes', async () => {
    const { db, orgId } = await migratedDb()
    const old = key()
    const f = await addFlock(db, orgId, 'f', (b) => seal('tok', ring(old), b))
    const r = ring(key(), [old])
    expect(await resealUpstreamAuth(db, r)).toEqual({ sealed: 0, resealed: 1, unreadable: [], vacuum: 'done' })
    const [row] = await db.select().from(flock).where(eq(flock.id, f.id))
    expect(row.upstreamAuthEnc!.split(':')[2]).toBe(r.current.kid)
    expect(openSealed(row.upstreamAuthEnc!, r, bindOf(row))).toBe('tok')
  })

  test('is idempotent: rows already under the current key and null rows are left alone', async () => {
    const { db, orgId } = await migratedDb()
    const r = ring(key())
    const a = await addFlock(db, orgId, 'a', (b) => seal('tok', r, b))
    await addFlock(db, orgId, 'b', null)
    expect(await resealUpstreamAuth(db, r)).toEqual({ sealed: 0, resealed: 0, unreadable: [], vacuum: 'not-needed' })
    const rows = await db.select().from(flock)
    expect(rows.map((x) => x.upstreamAuthEnc).sort()).toEqual([a.upstreamAuthEnc, null].sort())
  })

  test('a row under a key this stack does not hold is reported by id and name, left untouched, and does not fail the sweep', async () => {
    const { db, orgId } = await migratedDb()
    const f = await addFlock(db, orgId, 'restored', (b) => seal('tok', ring(key()), b))
    const r = ring(key())
    const report = await resealUpstreamAuth(db, r)
    expect(report).toEqual({ sealed: 0, resealed: 0, unreadable: [{ id: f.id, name: 'restored', reason: 'unknown-key' }], vacuum: 'not-needed' })
    const [row] = await db.select().from(flock).where(eq(flock.id, f.id))
    expect(row.upstreamAuthEnc).toBe(f.upstreamAuthEnc)
  })

  test('a rotation rewrites the table too, so envelopes under the retired key are not left behind', async () => {
    const { db, orgId } = await migratedDb()
    const old = key()
    await addFlock(db, orgId, 'f', (b) => seal('tok', ring(old), b))
    const filenode = async () =>
      ((await db.execute(sql`select pg_relation_filenode('flock') as n`)).rows[0] as { n: number }).n
    const before = await filenode()
    await resealUpstreamAuth(db, ring(key(), [old]))
    expect(await filenode()).not.toBe(before)
  })

  test('a VACUUM failure after the reseal committed is reported, not thrown, and the reseal stands', async () => {
    const { db, orgId } = await migratedDb()
    const old = key()
    const f = await addFlock(db, orgId, 'f', (b) => seal('tok', ring(old), b))
    const r = ring(key(), [old])
    const report = await resealUpstreamAuth(db, r, {
      vacuum: async () => { throw new Error('could not extend file: No space left on device') },
    })
    expect(report.resealed).toBe(1)
    expect(report.vacuum).toEqual({ failed: 'could not extend file: No space left on device' })
    const [row] = await db.select().from(flock).where(eq(flock.id, f.id))
    expect(row.upstreamAuthEnc!.split(':')[2]).toBe(r.current.kid)
  })

  test('an envelope moved onto another flock is reported as tampered, and left for the operator', async () => {
    const { db, orgId } = await migratedDb()
    const old = key()
    const a = await addFlock(db, orgId, 'a', (b) => seal('tok', ring(old), b))
    const b = await addFlock(db, orgId, 'b', null)
    await db.update(flock).set({ upstreamAuthEnc: a.upstreamAuthEnc }).where(eq(flock.id, b.id))
    const report = await resealUpstreamAuth(db, ring(key(), [old]))
    expect(report.resealed).toBe(1)
    expect(report.unreadable).toEqual([{ id: b.id, name: 'b', reason: 'tampered' }])
  })
})
