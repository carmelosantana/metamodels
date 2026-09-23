import { sql } from 'drizzle-orm'
import { boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

const id = () => uuid('id').primaryKey().defaultRandom()
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()

export const org = pgTable('org', {
  id: id(),
  name: text('name').notNull(),
  createdAt: createdAt(),
})

export const user = pgTable('user', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('admin'),
  status: text('status').notNull().default('active'),
  createdAt: createdAt(),
})

export const invite = pgTable('invite', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  createdAt: createdAt(),
})

export const entitlement = pgTable('entitlement', {
  id: id(),
  orgId: uuid('org_id').notNull().unique().references(() => org.id, { onDelete: 'cascade' }),
  licenseKeyEnc: text('license_key_enc').notNull(),
  licenseLast4: text('license_last4').notNull(),
  instanceId: text('instance_id'),
  status: text('status').notNull(),
  seats: integer('seats').notNull().default(1),
  tier: text('tier'),
  lastValidatedAt: timestamp('last_validated_at', { withTimezone: true }),
  graceUntil: timestamp('grace_until', { withTimezone: true }),
  createdAt: createdAt(),
})

export const flock = pgTable('flock', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  breed: text('breed').notNull(),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  // The credential sent upstream, SEALED (`@metamodels/schema/sealed`), never plaintext. `_enc` like
  // `license_key_enc`, and renamed from `upstream_auth` so that every reader of the old plaintext
  // field stopped compiling rather than quietly receiving ciphertext.
  upstreamAuthEnc: text('upstream_auth_enc'),
  tlsTrust: boolean('tls_trust').notNull().default(false),
  healthOk: boolean('health_ok'),
  createdAt: createdAt(),
}, (t) => [
  // The backstop for a future code path that forgets to seal. Added NOT VALID by the migration, so
  // pre-existing plaintext survives the upgrade until `migrate` seals it and validates this.
  check('flock_upstream_auth_sealed', sql`${t.upstreamAuthEnc} IS NULL OR ${t.upstreamAuthEnc} LIKE 'sealed:v1:%'`),
])

export const paddock = pgTable('paddock', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  flockId: uuid('flock_id').notNull().references(() => flock.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  status: text('status').notNull().default('active'),
  theme: text('theme').notNull().default('plain'),
  createdAt: createdAt(),
})

export const fence = pgTable('fence', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  paddockId: uuid('paddock_id').notNull().references(() => paddock.id, { onDelete: 'cascade' }),
  constraintJson: jsonb('constraint_json').notNull(),
  rateLimit: jsonb('rate_limit'),
  quota: jsonb('quota'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('fence_paddock').on(t.paddockId),
])

export const workflowTemplate = pgTable('workflow_template', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  flockId: uuid('flock_id').notNull().references(() => flock.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  graphJson: jsonb('graph_json').notNull(),
  paramSchema: jsonb('param_schema').notNull(),
  cost: integer('cost').notNull().default(1),
  createdAt: createdAt(),
})

export const apiKey = pgTable('api_key', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  prefix: text('prefix').notNull(),
  hash: text('hash').notNull().unique(),
  status: text('status').notNull().default('active'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  overrides: jsonb('overrides'),
  createdAt: createdAt(),
})

export const keyPaddock = pgTable('key_paddock', {
  id: id(),
  keyId: uuid('key_id').notNull().references(() => apiKey.id, { onDelete: 'cascade' }),
  paddockId: uuid('paddock_id').notNull().references(() => paddock.id, { onDelete: 'cascade' }),
})

export const usageRollup = pgTable('usage_rollup', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  keyId: uuid('key_id').notNull().references(() => apiKey.id, { onDelete: 'cascade' }),
  paddockId: uuid('paddock_id').notNull().references(() => paddock.id, { onDelete: 'cascade' }),
  period: text('period').notNull(), // e.g. '2026-07-25T14' (hour bucket)
  dim: text('dim').notNull(),
  value: integer('value').notNull().default(0),
}, (t) => [
  uniqueIndex('usage_rollup_key').on(t.orgId, t.keyId, t.paddockId, t.period, t.dim),
])

export const job = pgTable('job', {
  id: text('id').primaryKey(), // upstream job/prompt id (e.g. ComfyUI prompt_id)
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  keyId: uuid('key_id').notNull().references(() => apiKey.id, { onDelete: 'cascade' }),
  paddockId: uuid('paddock_id').notNull().references(() => paddock.id, { onDelete: 'cascade' }),
  templateId: text('template_id').notNull(), // fence-declared template id (NOT a DB FK)
  cost: integer('cost').notNull().default(1),
  metered: boolean('metered').notNull().default(false),
  submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull(),
})

export const auditLog = pgTable('audit_log', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  target: text('target').notNull(),
  detail: jsonb('detail'),
  /**
   * Which credential class performed the mutation: `session` for the console cookie path,
   * `token:<client_id>:<jti>` for an admin-API bearer. Nullable with no backfill — rows written
   * before M2 predate the concept, and null says exactly that. New code never writes null.
   */
  changedBy: text('changed_by'),
  createdAt: createdAt(),
})

/**
 * oidc-provider's persisted state (sessions, interactions, grants, codes, tokens), written only
 * by the auth service's adapter. `model` namespaces `id`. `expires_at` null = never expires;
 * rows past it are invisible to lookups and removed by the auth service's periodic sweep.
 */
export const oidcPayload = pgTable('oidc_payload', {
  model: text('model').notNull(),
  id: text('id').notNull(),
  payload: jsonb('payload').notNull(),
  grantId: text('grant_id'),
  userCode: text('user_code'),
  uid: text('uid'),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
}, (t) => [
  primaryKey({ columns: [t.model, t.id] }),
  index('oidc_payload_grant_id').on(t.grantId),
  index('oidc_payload_uid').on(t.uid),
  index('oidc_payload_user_code').on(t.userCode),
  index('oidc_payload_expires_at').on(t.expiresAt),
])
