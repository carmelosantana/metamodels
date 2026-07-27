import { and, eq } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { job } from '@metamodels/schema'
import type { JobRecord, JobStore } from '@metamodels/connectors'

type Db = PgDatabase<any, any, any>

/**
 * Durable {@link JobStore} backed by the Postgres `job` table.
 *
 * `markMetered` is a real cross-instance compare-and-set: a single
 * `UPDATE … WHERE metered = false RETURNING id` — the database guarantees only
 * one concurrent updater sees `metered = false`, so exactly one caller gets a
 * non-empty result set and meters the side effects.
 */
export class PostgresJobStore implements JobStore {
  constructor(private readonly db: Db) {}

  async create(rec: Omit<JobRecord, 'metered'>): Promise<JobRecord> {
    await this.db.insert(job).values({
      id: rec.jobId,
      orgId: rec.orgId,
      keyId: rec.keyId,
      paddockId: rec.paddockId,
      templateId: rec.templateId,
      cost: rec.cost,
      metered: false,
      submittedAt: new Date(rec.submittedAt),
    })
    return { ...rec, metered: false }
  }

  async get(jobId: string): Promise<JobRecord | null> {
    const rows = await this.db.select().from(job).where(eq(job.id, jobId)).limit(1)
    const r = rows[0]
    if (!r) return null
    return {
      jobId: r.id,
      orgId: r.orgId,
      keyId: r.keyId,
      paddockId: r.paddockId,
      templateId: r.templateId,
      cost: r.cost,
      metered: r.metered,
      submittedAt: r.submittedAt.getTime(),
    }
  }

  async markMetered(jobId: string): Promise<boolean> {
    const rows = await this.db
      .update(job)
      .set({ metered: true })
      .where(and(eq(job.id, jobId), eq(job.metered, false)))
      .returning({ id: job.id })
    return rows.length > 0
  }
}
