-- The upstream credential becomes a sealed envelope (see src/sealed.ts). SQL cannot seal — the key
-- is not in the database — so this migration only renames the column and adds the format check as
-- NOT VALID: existing plaintext rows survive it, every new write must be sealed, and the `migrate`
-- service seals the survivors and then runs VALIDATE CONSTRAINT (src/reseal.ts, run by apps/migrate).
ALTER TABLE "flock" RENAME COLUMN "upstream_auth" TO "upstream_auth_enc";--> statement-breakpoint
ALTER TABLE "flock" ADD CONSTRAINT "flock_upstream_auth_sealed" CHECK ("flock"."upstream_auth_enc" IS NULL OR "flock"."upstream_auth_enc" LIKE 'sealed:v1:%') NOT VALID;
