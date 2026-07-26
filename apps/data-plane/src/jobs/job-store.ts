import type { JobRecord, JobStore } from '@metamodels/connectors'

/**
 * In-memory {@link JobStore} keyed by `jobId`.
 *
 * This is the Redis/Postgres swap point later (Plan 4/5); for now a plain Map.
 * `markMetered` on an unknown job id is a no-op (the record simply does not
 * exist yet), so callers never need to guard against it.
 */
export class InMemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, JobRecord>()

  async create(job: Omit<JobRecord, 'metered'>): Promise<JobRecord> {
    const record: JobRecord = { ...job, metered: false }
    this.jobs.set(record.jobId, record)
    return record
  }

  async get(jobId: string): Promise<JobRecord | null> {
    return this.jobs.get(jobId) ?? null
  }

  async markMetered(jobId: string): Promise<void> {
    const record = this.jobs.get(jobId)
    if (record) record.metered = true
  }
}
