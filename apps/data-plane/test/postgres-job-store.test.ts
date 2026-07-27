import { describe, expect, test } from 'vitest'
import type { JobRecord } from '@metamodels/connectors'
import { PostgresJobStore } from '../src/jobs/postgres-job-store.js'
import { makeDb, seedFixture } from './helpers/seed.js'

async function storeWithScope() {
  const db = await makeDb()
  const fx = await seedFixture(db) // gives real orgId/keyId/paddockId (FK-valid)
  return { store: new PostgresJobStore(db), fx }
}

function sample(fx: { orgId: string; keyId: string; paddockId: string }): Omit<JobRecord, 'metered'> {
  return { jobId: 'job-1', orgId: fx.orgId, keyId: fx.keyId, paddockId: fx.paddockId, templateId: 't', cost: 5, submittedAt: 100 }
}

describe('PostgresJobStore', () => {
  test('create then get round-trips the record with metered:false', async () => {
    const { store, fx } = await storeWithScope()
    const created = await store.create(sample(fx))
    expect(created).toEqual({ ...sample(fx), metered: false })
    expect(await store.get('job-1')).toEqual({ ...sample(fx), metered: false })
  })

  test('create of a duplicate jobId is a no-op that preserves the existing metered flag', async () => {
    const { store, fx } = await storeWithScope()
    await store.create(sample(fx))
    expect(await store.markMetered('job-1')).toBe(true) // metered = true on the existing row
    // Second create with the SAME id must not throw and must NOT reset metered/ownership.
    await expect(store.create(sample(fx))).resolves.toBeDefined()
    expect((await store.get('job-1'))!.metered).toBe(true)
  })

  test('get of an unknown id returns null', async () => {
    const { store } = await storeWithScope()
    expect(await store.get('nope')).toBeNull()
  })

  test('markMetered is a compare-and-set: true once, false thereafter', async () => {
    const { store, fx } = await storeWithScope()
    await store.create(sample(fx))
    expect(await store.markMetered('job-1')).toBe(true)
    expect(await store.markMetered('job-1')).toBe(false)
    expect((await store.get('job-1'))!.metered).toBe(true)
  })

  test('markMetered on unknown id returns false', async () => {
    const { store } = await storeWithScope()
    expect(await store.markMetered('nope')).toBe(false)
  })

  test('concurrent markMetered: exactly one caller wins', async () => {
    const { store, fx } = await storeWithScope()
    await store.create(sample(fx))
    const results = await Promise.all([store.markMetered('job-1'), store.markMetered('job-1'), store.markMetered('job-1')])
    expect(results.filter((r) => r === true)).toHaveLength(1)
  })
})
