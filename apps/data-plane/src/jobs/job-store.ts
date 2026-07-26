import type { JobRecord, JobStore } from '@metamodels/connectors'

/**
 * In-memory {@link JobStore} keyed by `jobId`.
 *
 * This is the Redis/Postgres swap point later (Plan 4/5); for now a plain Map.
 * `get`/`create` return SHALLOW COPIES so external callers can never mutate the
 * store's internal state; `markMetered` performs an atomic compare-and-set on
 * the internal record (the single-threaded event loop guarantees the read+set
 * has no interleaving await), returning whether this call won the transition.
 */
export class InMemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, JobRecord>()

  async create(job: Omit<JobRecord, 'metered'>): Promise<JobRecord> {
    const record: JobRecord = { ...job, metered: false }
    this.jobs.set(record.jobId, record)
    return { ...record }
  }

  async get(jobId: string): Promise<JobRecord | null> {
    const record = this.jobs.get(jobId)
    return record ? { ...record } : null
  }

  async markMetered(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId)
    if (!job || job.metered) return false
    job.metered = true
    return true
  }
}
