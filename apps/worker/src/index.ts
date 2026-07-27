import Redis from 'ioredis'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from '@metamodels/schema'
import { ensureGroup, processOnce } from './worker.js'

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  const redisUrl = process.env.REDIS_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  if (!redisUrl) throw new Error('REDIS_URL is required')

  const db = drizzle(postgres(databaseUrl), { schema })
  const redis = new Redis(redisUrl)
  const consumer = process.env.WORKER_NAME ?? `worker-${process.pid}`

  await ensureGroup(redis)
  // eslint-disable-next-line no-console
  console.log(`metamodels worker "${consumer}" consuming ${'metamodels:meters'}`)

  // Continuous loop: readBatch BLOCKs up to 1s when idle, so this is not a busy-spin.
  for (;;) {
    try {
      await processOnce(redis, db, consumer)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('worker cycle failed; retrying', err)
    }
  }
}

// Only run when executed directly, not when imported by tests.
if (process.argv[1] && process.argv[1].endsWith('index.ts')) {
  void main()
}
