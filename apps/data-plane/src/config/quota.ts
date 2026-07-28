// The rate-limit + quota config shapes live in @metamodels/schema/config (the single
// source of truth shared with the control-plane). Re-exported here so existing importers
// (app.ts) keep their import path.
export { quotaRuleSchema, quotaSchema } from '@metamodels/schema/config'
export type { QuotaRule } from '@metamodels/schema/config'
