import { describe, expect, test } from 'vitest'
import type { JobRecord } from '@metamodels/connectors'
import { InMemoryJobStore } from '../src/jobs/job-store.js'

const sample: Omit<JobRecord, 'metered'> = {
  jobId: 'job-1',
  keyId: 'k',
  paddockId: 'p',
  orgId: 'o',
  templateId: 't',
  cost: 5,
  submittedAt: 100,
}

describe('InMemoryJobStore', () => {
  test('create stores the record with metered:false and returns it', async () => {
    const store = new InMemoryJobStore()
    const rec = await store.create(sample)
    expect(rec).toEqual({ ...sample, metered: false })
  })

  test('get returns the stored record', async () => {
    const store = new InMemoryJobStore()
    await store.create(sample)
    expect(await store.get('job-1')).toEqual({ ...sample, metered: false })
  })

  test('get of an unknown id returns null', async () => {
    const store = new InMemoryJobStore()
    expect(await store.get('nope')).toBeNull()
  })

  test('markMetered flips the flag', async () => {
    const store = new InMemoryJobStore()
    await store.create(sample)
    await store.markMetered('job-1')
    expect(await store.get('job-1')).toEqual({ ...sample, metered: true })
  })

  test('markMetered is a compare-and-set: true on first call, false thereafter', async () => {
    const store = new InMemoryJobStore()
    await store.create(sample)
    expect(await store.markMetered('job-1')).toBe(true)
    expect(await store.markMetered('job-1')).toBe(false)
  })

  test('markMetered on an unknown id returns false (no-op)', async () => {
    const store = new InMemoryJobStore()
    await expect(store.markMetered('nope')).resolves.toBe(false)
    expect(await store.get('nope')).toBeNull()
  })

  test('get returns a copy: mutating the returned record does not change the store', async () => {
    const store = new InMemoryJobStore()
    await store.create(sample)
    const first = await store.get('job-1')
    expect(first).not.toBeNull()
    first!.metered = true
    first!.cost = 999
    const second = await store.get('job-1')
    expect(second).toEqual({ ...sample, metered: false })
  })
})
