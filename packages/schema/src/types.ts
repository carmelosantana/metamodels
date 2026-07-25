import type {
  apiKey, auditLog, fence, flock, keyPaddock, org, paddock, user,
  usageRollup, workflowTemplate,
} from './schema.js'

export type Org = typeof org.$inferSelect
export type NewOrg = typeof org.$inferInsert
export type User = typeof user.$inferSelect
export type NewUser = typeof user.$inferInsert
export type Flock = typeof flock.$inferSelect
export type NewFlock = typeof flock.$inferInsert
export type Paddock = typeof paddock.$inferSelect
export type NewPaddock = typeof paddock.$inferInsert
export type Fence = typeof fence.$inferSelect
export type NewFence = typeof fence.$inferInsert
export type WorkflowTemplate = typeof workflowTemplate.$inferSelect
export type NewWorkflowTemplate = typeof workflowTemplate.$inferInsert
export type ApiKey = typeof apiKey.$inferSelect
export type NewApiKey = typeof apiKey.$inferInsert
export type KeyPaddock = typeof keyPaddock.$inferSelect
export type UsageRollup = typeof usageRollup.$inferSelect
export type AuditLog = typeof auditLog.$inferSelect
