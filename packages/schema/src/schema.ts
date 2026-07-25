import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

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
  createdAt: createdAt(),
})

export const flock = pgTable('flock', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  breed: text('breed').notNull(),
  name: text('name').notNull(),
  baseUrl: text('base_url').notNull(),
  upstreamAuth: text('upstream_auth'),
  tlsTrust: boolean('tls_trust').notNull().default(false),
  healthOk: boolean('health_ok'),
  createdAt: createdAt(),
})

export const paddock = pgTable('paddock', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  flockId: uuid('flock_id').notNull().references(() => flock.id, { onDelete: 'cascade' }),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  status: text('status').notNull().default('active'),
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
})

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
})

export const auditLog = pgTable('audit_log', {
  id: id(),
  orgId: uuid('org_id').notNull().references(() => org.id, { onDelete: 'cascade' }),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  target: text('target').notNull(),
  detail: jsonb('detail'),
  createdAt: createdAt(),
})
