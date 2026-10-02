import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest'
import { loadSealKeyring, openSealed, seal, type SealBinding } from '@metamodels/schema/sealed'
import { runMigrations } from '../src/index'

// Kanboard #4560: the upgrade's seal pass, killed part-way on a REAL Postgres and run again. PGlite has
// one connection, so it cannot show a second session watching the run, ending it, or what is left on
// disk. Skips unless PG_TEST_URL names a Postgres whose user may create databases and extensions.
const PG_TEST_URL = process.env.PG_TEST_URL
const migrationsFolder = fileURLToPath(new URL('../../../packages/schema/drizzle', import.meta.url))
const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url))
const tsx = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url))
const key = () => randomBytes(32).toString('base64')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const CRASH_LOCK = 4560

/** The migrations folder as it stood at `lastIdx`, so the database starts at the pre-0008 schema. */
function foldersUpTo(lastIdx: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'mm-migrations-'))
  cpSync(migrationsFolder, dir, { recursive: true })
  const journalPath = join(dir, 'meta/_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] }
  journal.entries = journal.entries.filter((e) => e.idx <= lastIdx)
  writeFileSync(journalPath, JSON.stringify(journal))
  return dir
}

describe.skipIf(!PG_TEST_URL)('the upgrade seal pass, killed part-way on real Postgres (Kanboard #4560)', () => {
  let admin: postgres.Sql
  const opened: { name: string; sql: postgres.Sql }[] = []
  beforeAll(() => { admin = postgres(PG_TEST_URL!, { max: 1, onnotice: () => {} }) })
  afterEach(async () => {
    for (const { name, sql } of opened.splice(0)) {
      await sql.end()
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    }
  })
  afterAll(async () => { await admin?.end() })

  const oldKey = key()
  const curKey = key()
  const ring = loadSealKeyring({ UPSTREAM_AUTH_KEY: curKey, UPSTREAM_AUTH_PREVIOUS_KEYS: oldKey })

  /**
   * A database of its own (the pass sweeps every flock row, and the shared CI database has others'),
   * at the pre-0008 schema: four plaintext credentials (the upgrade) and two under a retired key (a rotation).
   */
  async function legacyDatabase() {
    const name = `mm_reseal_crash_${randomUUID().replaceAll('-', '')}`
    await admin.unsafe(`CREATE DATABASE "${name}"`)
    const u = new URL(PG_TEST_URL!)
    u.pathname = `/${name}`
    const sql = postgres(u.toString(), { max: 1, onnotice: () => {} })
    opened.push({ name, sql })
    await migrate(drizzle(sql), { migrationsFolder: foldersUpTo(7) })
    await sql`CREATE EXTENSION IF NOT EXISTS pageinspect`
    const [{ id: orgId }] = await sql<{ id: string }[]>`INSERT INTO "org" (name) VALUES ('o') RETURNING id`
    const want = new Map<string, string>()
    for (let i = 0; i < 6; i++) {
      const id = randomUUID()
      const secret = `Bearer crash-secret-${i}-${randomUUID()}`
      const bind: SealBinding = { orgId: orgId!, flockId: id }
      const stored = i < 4 ? secret : seal(secret, loadSealKeyring({ UPSTREAM_AUTH_KEY: oldKey }), bind)
      await sql`INSERT INTO "flock" (id, org_id, breed, name, base_url, upstream_auth)
        VALUES (${id}, ${orgId!}, 'ollama', ${`f${i}`}, 'http://o', ${stored})`
      want.set(id, secret)
    }
    return { name, url: u.toString(), sql, want }
  }
  type Db = Awaited<ReturnType<typeof legacyDatabase>>

  /** Every page of the flock table, raw, searched for `needle`: dead row versions and free space included. */
  async function onDisk(sql: postgres.Sql, needle: string): Promise<boolean> {
    const [row] = await sql`
      SELECT count(*)::int AS n FROM generate_series(0, (pg_relation_size('flock') / current_setting('block_size')::int)::int - 1) AS b
      WHERE position(convert_to(${needle}, 'UTF8') in get_raw_page('flock', b)) > 0`
    return row!.n > 0
  }

  /** The pid of the backend in `db` waiting on a lock of `kind` ('advisory', 'relation'), once there is one. */
  async function waiting(db: Db, kind: string): Promise<number> {
    for (let i = 0; i < 400; i++) {
      const [w] = await db.sql<{ pid: number }[]>`SELECT pid FROM pg_stat_activity
        WHERE datname = ${db.name} AND wait_event_type = 'Lock' AND wait_event = ${kind}`
      if (w) return w.pid
      await sleep(50)
    }
    throw new Error(`no backend ever waited on a ${kind} lock`)
  }

  /** The migrate service itself, as compose runs it. */
  function migrateService(db: Db) {
    const child = spawn(tsx, [entry], {
      env: { ...process.env, DATABASE_URL: db.url, UPSTREAM_AUTH_KEY: curKey, UPSTREAM_AUTH_PREVIOUS_KEYS: oldKey },
      stdio: 'ignore',
    })
    const exited = new Promise<NodeJS.Signals | null>((r) => child.on('exit', (_code, signal) => r(signal)))
    return { child, exited }
  }

  /**
   * Kill the service outright (no handler, no rollback of its own), then end its backend, which is
   * parked on a lock and has not yet seen the socket close, as Postgres would on its next read.
   */
  async function kill(db: Db, svc: ReturnType<typeof migrateService>, pid: number) {
    svc.child.kill('SIGKILL')
    expect(await svc.exited).toBe('SIGKILL')
    await db.sql`SELECT pg_terminate_backend(${pid})`
    for (let i = 0; i < 100 && (await db.sql`SELECT 1 FROM pg_stat_activity WHERE pid = ${pid}`).length > 0; i++) await sleep(50)
  }

  /** Every credential sealed exactly once under the current key, and none of them on disk in the clear. */
  async function expectSealedOnce(db: Db) {
    const currentOnly = loadSealKeyring({ UPSTREAM_AUTH_KEY: curKey })
    const rows = await db.sql<{ id: string; org_id: string; v: string }[]>`SELECT id, org_id, upstream_auth_enc AS v FROM "flock"`
    expect(rows).toHaveLength(6)
    // Opens under the current key alone, to the original secret: sealed once, not an envelope of an envelope.
    for (const row of rows) expect(openSealed(row.v, currentOnly, { orgId: row.org_id, flockId: row.id })).toBe(db.want.get(row.id))
    for (const secret of db.want.values()) expect(await onDisk(db.sql, secret), secret).toBe(false)
  }

  const stored = async (db: Db, column: string) =>
    new Map((await db.sql<{ id: string; v: string }[]>`SELECT id, ${db.sql(column)} AS v FROM "flock"`).map((r) => [r.id, r.v]))

  test('killed mid-transaction: every credential is as it was; the re-run seals each exactly once and leaves no plaintext', async () => {
    const db = await legacyDatabase()
    // The positive anchor for the on-disk check: before the pass, the page search finds the plaintext.
    for (const [i, secret] of [...db.want.values()].entries()) if (i < 4) expect(await onDisk(db.sql, secret), secret).toBe(true)
    const before = await stored(db, 'upstream_auth')

    // The third row update inside the pass waits on a lock this session holds, so the run is caught
    // with two rows rewritten and nothing committed. Sequences ignore rollback, so the count is visible.
    await db.sql.unsafe(`
      CREATE SEQUENCE crash_ctr;
      CREATE FUNCTION crash_gate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF nextval('crash_ctr') = 3 THEN PERFORM pg_advisory_xact_lock(${CRASH_LOCK}); END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER crash_gate BEFORE UPDATE ON "flock" FOR EACH ROW EXECUTE FUNCTION crash_gate();`)
    await db.sql`SELECT pg_advisory_lock(${CRASH_LOCK})`
    const svc = migrateService(db)
    const pid = await waiting(db, 'advisory')
    expect((await db.sql`SELECT last_value::int AS n FROM crash_ctr`)[0]!.n).toBe(3)
    await kill(db, svc, pid)
    await db.sql`SELECT pg_advisory_unlock(${CRASH_LOCK})`
    await db.sql.unsafe(`DROP TRIGGER crash_gate ON "flock"; DROP FUNCTION crash_gate(); DROP SEQUENCE crash_ctr;`)

    // The kill rolled the pass back whole: no credential lost, none half-sealed, none sealed twice.
    expect(await stored(db, 'upstream_auth_enc')).toEqual(before)

    expect(await runMigrations(db.url, ring)).toMatchObject({ sealed: 4, resealed: 2, unreadable: [], vacuum: 'done' })
    await expectSealedOnce(db)
    // And a third run finds nothing left to do.
    expect(await runMigrations(db.url, ring)).toMatchObject({ sealed: 0, resealed: 0, vacuum: 'not-needed' })
  })
})
