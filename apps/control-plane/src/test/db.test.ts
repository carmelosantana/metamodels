import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sql } from 'drizzle-orm'
import { flock, org } from '@metamodels/schema'
import { freshDb, resetDb, seedOrg, sharedDb, type TestDb } from './db'

let db: TestDb
beforeAll(async () => { db = await freshDb() })
afterAll(async () => { await db.$client.close() })

const count = async (table: string) =>
  (await db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from "${table}"`))).rows[0].n

test('resetDb empties every public table and keeps the migrated schema', async () => {
  const o = await seedOrg(db)
  await db.insert(flock).values({ orgId: o.id, breed: 'ollama', name: 'f', baseUrl: 'http://u:11434' })

  await resetDb(db)

  expect(await count('org')).toBe(0)
  expect(await count('flock')).toBe(0)
  // The schema and the migration journal survive, so the next case seeds without migrating again.
  await db.insert(org).values({ name: 'again' })
  expect(await count('org')).toBe(1)
  const { rows } = await db.execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)
  expect(rows[0].n).toBeGreaterThan(0)
})

describe('sharedDb', () => {
  const shared = sharedDb()
  let seen: TestDb | undefined

  // Two identical cases, so the claim holds in any order and with either one run alone: whichever
  // runs second finds the same database, with the first one's row gone.
  test.each(['one', 'two'])('hands case %s the file database, empty and writable', async () => {
    seen ??= shared()
    expect(shared()).toBe(seen)
    expect(await shared().select().from(org)).toHaveLength(0)
    await seedOrg(shared())
    expect(await shared().select().from(org)).toHaveLength(1)
  })
})

const here = dirname(fileURLToPath(import.meta.url))
const vitestBin = resolve(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs')

/** Runs one file under test/fixtures in a child vitest and returns each case's status by title. */
async function runFixture(file: string): Promise<Record<string, string>> {
  const out = await mkdtemp(join(tmpdir(), 'shared-db-'))
  try {
    const report = join(out, 'report.json')
    // Drop the parent run's VITEST_* markers so the child behaves as a top-level run.
    const env = { ...process.env }
    for (const k of Object.keys(env)) if (k.startsWith('VITEST')) delete env[k]
    await new Promise<void>((done) => {
      execFile(process.execPath, [vitestBin, 'run', file, '--config', join(here, 'fixtures/vitest.config.ts'),
        '--reporter=json', `--outputFile=${report}`], { env }, () => done())
    })
    const { testResults } = JSON.parse(await readFile(report, 'utf8')) as {
      testResults: { assertionResults: { title: string; status: string }[] }[]
    }
    return Object.fromEntries(testResults.flatMap((r) => r.assertionResults.map((a) => [a.title, a.status])))
  } finally {
    await rm(out, { recursive: true, force: true })
  }
}

test('a case that fails while still using the database does not reach the next case', async () => {
  expect(await runFixture('shared-db-after-failure.fixture.ts')).toEqual({
    'times out, then writes into its database': 'failed',
    'sees nothing of the late write': 'passed',
    'times out holding a transaction open': 'failed',
    'gets a usable database after the hung transaction': 'passed',
  })
}, 120_000)

test('migrating leaves every public table empty, so resetDb wipes no seeded rows', async () => {
  const fresh = await freshDb()
  try {
    const { rows } = await fresh.execute<{ t: string }>(sql`select tablename as t from pg_tables where schemaname = 'public'`)
    expect(rows.length).toBeGreaterThan(0)
    for (const { t } of rows) {
      const n = (await fresh.execute<{ n: number }>(sql.raw(`select count(*)::int as n from "${t}"`))).rows[0].n
      expect({ table: t, rows: n }).toEqual({ table: t, rows: 0 })
    }
  } finally {
    await fresh.$client.close()
  }
})
