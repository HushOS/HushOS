-- Hand-edited (this header, the lock timeout and NOT VALID). Deleting a family folder
-- (docs/groups-design.md 2.10): "deleted_at" is nullable with no default, so adding it rewrites
-- nothing, and every existing row is null, which the new check allows; the check is added NOT
-- VALID so the table is not scanned under the lock, and a later release validates it. The partial
-- index holds no row yet; building it reads "workspaces" once (one row per account and per family
-- folder) while drizzle's single transaction holds the lock. Each statement waits at most five
-- seconds for its lock and fails, to be retried, rather than queue requests behind it.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "workspaces_deleted_idx" ON "workspaces" ("deleted_at") WHERE "deleted_at" is not null;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_deleted_valid" CHECK ("deleted_at" is null or "group_id" is not null) NOT VALID;
