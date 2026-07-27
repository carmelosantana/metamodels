CREATE TABLE "job" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"key_id" uuid NOT NULL,
	"paddock_id" uuid NOT NULL,
	"template_id" text NOT NULL,
	"cost" integer DEFAULT 1 NOT NULL,
	"metered" boolean DEFAULT false NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_org_id_org_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."org"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_key_id_api_key_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."api_key"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_paddock_id_paddock_id_fk" FOREIGN KEY ("paddock_id") REFERENCES "public"."paddock"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "usage_rollup_key" ON "usage_rollup" USING btree ("org_id","key_id","paddock_id","period","dim");