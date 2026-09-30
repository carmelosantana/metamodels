ALTER TABLE "api_key" ADD COLUMN "kind" text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "api_key" ADD COLUMN "grant_id" text;--> statement-breakpoint
ALTER TABLE "api_key" ADD COLUMN "oauth_client_id" text;--> statement-breakpoint
ALTER TABLE "api_key" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_key_grant_id" ON "api_key" USING btree ("grant_id");--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_kind" CHECK ("api_key"."kind" IN ('live', 'oauth'));--> statement-breakpoint
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_oauth_binding" CHECK (("api_key"."kind" = 'oauth' AND "api_key"."grant_id" IS NOT NULL AND "api_key"."oauth_client_id" IS NOT NULL AND "api_key"."user_id" IS NOT NULL) OR ("api_key"."kind" = 'live' AND "api_key"."grant_id" IS NULL AND "api_key"."oauth_client_id" IS NULL AND "api_key"."user_id" IS NULL));