import { expect, test } from 'vitest'
import { org } from '@metamodels/schema'
import { seedOrg, sharedDb } from '../db'

// Each odd case fails by timing out while still using its database. The even case after it must
// get a clean, usable one anyway. db.test.ts runs this file and checks each case's outcome.
const testDb = sharedDb()
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))

test('times out, then writes into its database', async () => {
  const db = testDb()
  await sleep(1_000)
  await seedOrg(db)
}, 200)

test('sees nothing of the late write', async () => {
  await sleep(1_500)
  expect(await testDb().select().from(org)).toHaveLength(0)
})

test('times out holding a transaction open', async () => {
  await testDb().transaction(() => new Promise<void>(() => {}))
}, 200)

test('gets a usable database after the hung transaction', async () => {
  expect(await testDb().select().from(org)).toHaveLength(0)
})
