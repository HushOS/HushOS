-- Hand-edited (this header, the lock timeout and NOT VALID). A move between a person's own files
-- and their family's folders (docs/families-shared-pool.md 3.8): six nullable columns on
-- "drive_uploads" with no default, so adding them rewrites nothing and every existing row is null,
-- which the new check allows; the check is added NOT VALID so the table is not scanned under the
-- lock, and a later release validates it. The partial unique index holds no row yet (every
-- move_node_id is null); building it reads "drive_uploads" once while drizzle's transaction
-- holds the table's lock, so uploads begin and complete a moment later. Each statement waits at
-- most five seconds for a lock and fails, to be retried, rather than queue behind one.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "drive_uploads" ADD COLUMN "move_workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "drive_uploads" ADD COLUMN "move_node_id" uuid;--> statement-breakpoint
ALTER TABLE "drive_uploads" ADD COLUMN "move_version_id" uuid;--> statement-breakpoint
ALTER TABLE "drive_uploads" ADD COLUMN "move_change_seq" bigint;--> statement-breakpoint
ALTER TABLE "drive_uploads" ADD COLUMN "move_freed_bytes" bigint;--> statement-breakpoint
ALTER TABLE "drive_uploads" ADD COLUMN "move_by" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "drive_uploads_one_move_idx" ON "drive_uploads" ("move_node_id") WHERE status in ('open', 'completing', 'conflicted') and move_node_id is not null;--> statement-breakpoint
ALTER TABLE "drive_uploads" ADD CONSTRAINT "drive_uploads_move_whole" CHECK (("move_node_id" is null) = ("move_workspace_id" is null) and ("move_node_id" is null) = ("move_version_id" is null) and ("move_node_id" is null) = ("move_change_seq" is null) and ("move_node_id" is null) = ("move_freed_bytes" is null) and ("move_node_id" is null) = ("move_by" is null) and ("move_freed_bytes" is null or "move_freed_bytes" >= 0)) NOT VALID;
