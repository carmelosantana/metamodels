import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as schema from '@metamodels/schema'
import { hashApiKey } from '@metamodels/schema'
import { randomBytes, randomUUID } from 'node:crypto'
import { loadSealKeyring, type SealBinding, type SealKeyring } from '@metamodels/schema/sealed'

/** A keyring for tests: fresh per process, so nothing sealed here can open anywhere else. */
export const testRing = (): SealKeyring => loadSealKeyring({ UPSTREAM_AUTH_KEY: randomBytes(32).toString('base64') })
export const TEST_RING = testRing()

export type TestDb = ReturnType<typeof drizzle<typeof schema>>

export async function makeDb(): Promise<TestDb> {
  const client = new PGlite()
  const db = drizzle(client, { schema })
  // migrations live in the schema package's drizzle/ dir
  const here = dirname(fileURLToPath(import.meta.url))
  const migrationsFolder = resolve(here, '../../../../packages/schema/drizzle')
  await migrate(db, { migrationsFolder })
  return db
}

export interface Fixture {
  orgId: string; paddockId: string; keyId: string
  keyPlaintext: string; keyHash: string; slug: string
}

/** `sealFor` builds the flock's stored credential for the ids it is stored under (see `sealed.ts`). */
export async function seedFixture(
  db: TestDb, opts: { sealFor?: (bind: SealBinding) => string } = {},
): Promise<Fixture & { flockId: string }> {
  const [org] = await db.insert(schema.org).values({ name: 'default' }).returning()
  const flockId = randomUUID()
  const [flock] = await db.insert(schema.flock).values({
    id: flockId, orgId: org.id, breed: 'ollama', name: 'local', baseUrl: 'http://fake.ollama',
    upstreamAuthEnc: opts.sealFor ? opts.sealFor({ orgId: org.id, flockId }) : null,
  }).returning()
  const [paddock] = await db.insert(schema.paddock).values({
    orgId: org.id, flockId: flock.id, slug: 'small', name: 'Small models',
  }).returning()
  await db.insert(schema.fence).values({
    orgId: org.id, paddockId: paddock.id,
    constraintJson: { allowedRoutes: ['chat', 'generate', 'embed', 'read'], allowedModels: ['llama3.2:1b'] },
    rateLimit: { windowSec: 60, max: 5 }, quota: null,
  })
  const keyPlaintext = 'mm_live_testkey'
  const keyHash = hashApiKey(keyPlaintext)
  const [key] = await db.insert(schema.apiKey).values({
    orgId: org.id, name: 'test', prefix: keyPlaintext.slice(0, 12), hash: keyHash, status: 'active',
  }).returning()
  await db.insert(schema.keyPaddock).values({ keyId: key.id, paddockId: paddock.id })
  return { orgId: org.id, flockId: flock.id, paddockId: paddock.id, keyId: key.id, keyPlaintext, keyHash, slug: 'small' }
}

/**
 * An oauth key as the control plane's `mintOauthKey` writes it (M4 D1): bound to a grant, a client and
 * the user who approved it, scoped to the fixture's paddock (or `paddockId`). Its hash is of random bytes nobody kept.
 */
export async function seedOauthKey(
  db: TestDb,
  fx: Fixture,
  opts: { clientId?: string; grantId?: string; status?: string; paddockId?: string } = {},
): Promise<{ keyId: string; hash: string; clientId: string; userId: string }> {
  const clientId = opts.clientId ?? 'https://mcp-client.example.test/client.json'
  const [u] = await db.insert(schema.user).values({
    orgId: fx.orgId, email: `approver-${randomUUID()}@x.io`, passwordHash: 'unused', role: 'member',
  }).returning()
  const hash = randomBytes(32).toString('hex')
  const [key] = await db.insert(schema.apiKey).values({
    orgId: fx.orgId, name: 'Test MCP client (MCP)', prefix: 'oauth', hash, status: opts.status ?? 'active',
    kind: 'oauth', grantId: opts.grantId ?? randomUUID(), oauthClientId: clientId, userId: u.id,
  }).returning()
  await db.insert(schema.keyPaddock).values({ keyId: key.id, paddockId: opts.paddockId ?? fx.paddockId })
  return { keyId: key.id, hash, clientId, userId: u.id }
}
