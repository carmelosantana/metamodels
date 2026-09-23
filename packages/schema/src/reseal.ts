import { isNotNull, sql, eq } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import { flock } from './schema.js'
import { isSealed, needsReseal, openSealed, seal, UnsealError, type SealKeyring, type UnsealReason } from './sealed.js'

export interface ResealReport {
  /** Legacy plaintext rows sealed for the first time. */
  sealed: number
  /** Rows moved from a previous key to the current one. */
  resealed: number
  /** Rows this keyring cannot open — never an id's secret, only which flock needs re-entering. */
  unreadable: { id: string; name: string; reason: UnsealReason }[]
}

/**
 * Brings every stored upstream credential under the CURRENT key, then validates the format check
 * that migration 0008 added NOT VALID. Run by `migrate` after the SQL migrations, before any other
 * service starts, so it is both the one-time upgrade (plaintext → sealed) and the second half of
 * every key rotation. Idempotent.
 *
 * An unreadable row is reported and left exactly as it is, not failed on: one flock restored from
 * a backup taken under another key should cost that flock its credential (the data plane fails it
 * closed; re-entering it through the console or `PUT /flocks/{id}` re-seals it), not keep the whole
 * stack from starting. And it is kept, not nulled, so putting the right key back recovers it.
 */
export async function resealUpstreamAuth(db: PgDatabase<any, any, any>, ring: SealKeyring): Promise<ResealReport> {
  const report: ResealReport = { sealed: 0, resealed: 0, unreadable: [] }
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: flock.id, name: flock.name, value: flock.upstreamAuthEnc })
      .from(flock)
      .where(isNotNull(flock.upstreamAuthEnc))
      .for('update')
    for (const row of rows) {
      const value = row.value!
      if (!needsReseal(value, ring)) continue
      let plaintext: string
      if (!isSealed(value)) {
        // Only a pre-0008 row can be here: the check constraint refuses any new unsealed write.
        plaintext = value
        report.sealed++
      } else {
        try {
          plaintext = openSealed(value, ring)
        } catch (e) {
          if (!(e instanceof UnsealError)) throw e
          report.unreadable.push({ id: row.id, name: row.name, reason: e.reason })
          continue
        }
        report.resealed++
      }
      await tx.update(flock).set({ upstreamAuthEnc: seal(plaintext, ring) }).where(eq(flock.id, row.id))
    }
    await tx.execute(sql`ALTER TABLE "flock" VALIDATE CONSTRAINT "flock_upstream_auth_sealed"`)
  })
  return report
}
