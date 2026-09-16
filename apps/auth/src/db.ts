import type { PgDatabase } from 'drizzle-orm/pg-core'

/** Any Drizzle Postgres database — postgres-js in production, pglite in tests. */
export type Db = PgDatabase<any, any, any>
