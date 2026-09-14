CREATE TABLE "drive_sweeps" (
	"name" text PRIMARY KEY,
	"cursor" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "drive_objects" ADD COLUMN "audited_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "drive_objects_audit_idx" ON "drive_objects" ("audited_at") WHERE status in ('ready', 'missing');--> statement-breakpoint
CREATE INDEX "drive_objects_tier_idx" ON "drive_objects" ("storage_class","last_read_at") WHERE status = 'ready';