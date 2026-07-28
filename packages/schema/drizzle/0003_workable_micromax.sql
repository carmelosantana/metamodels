ALTER TABLE "paddock" ADD COLUMN "theme" text DEFAULT 'plain' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "fence_paddock" ON "fence" USING btree ("paddock_id");