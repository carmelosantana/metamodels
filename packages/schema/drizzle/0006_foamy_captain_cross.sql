CREATE TABLE "oidc_payload" (
	"model" text NOT NULL,
	"id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"grant_id" text,
	"user_code" text,
	"uid" text,
	"expires_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "oidc_payload_model_id_pk" PRIMARY KEY("model","id")
);
--> statement-breakpoint
CREATE INDEX "oidc_payload_grant_id" ON "oidc_payload" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "oidc_payload_uid" ON "oidc_payload" USING btree ("uid");--> statement-breakpoint
CREATE INDEX "oidc_payload_user_code" ON "oidc_payload" USING btree ("user_code");--> statement-breakpoint
CREATE INDEX "oidc_payload_expires_at" ON "oidc_payload" USING btree ("expires_at");