CREATE TABLE "entitlement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"license_key_enc" text NOT NULL,
	"license_last4" text NOT NULL,
	"instance_id" text,
	"status" text NOT NULL,
	"seats" integer DEFAULT 1 NOT NULL,
	"tier" text,
	"last_validated_at" timestamp with time zone,
	"grace_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entitlement_org_id_unique" UNIQUE("org_id")
);
--> statement-breakpoint
ALTER TABLE "entitlement" ADD CONSTRAINT "entitlement_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;