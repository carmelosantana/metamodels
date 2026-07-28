import { drizzle } from 'drizzle-orm/postgres-js'
import type { PgDatabase } from 'drizzle-orm/pg-core'
import postgres from 'postgres'
import * as schema from '@metamodels/schema'

export type Db = PgDatabase<any, any, any>

let cached: Db | undefined

export function getDb(): Db {
  if (cached) return cached
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required')
  cached = drizzle(postgres(url), { schema })
  return cached
}
