-- Hand-edited (this header, the lock timeout, the order of the ALTERs, NOT VALID, the primary key
-- swapped in one statement, the index on "drive_objects" left out, and the UPDATE of
-- "drive_sweeps"). The deletion outbox keyed by object and store
-- (docs/company-storage-design.md 8.4, 11.1; its PR 2): "drive_object_deletions" gets
-- (object_id, store_id) as its primary key in place of (object_id), and the columns "reason",
-- "backup_store_id", "export_store_id", "export_last_seq", "held_by_move", "not_before",
-- "backup_left", "attention", "failures" and "failed_at". "drive_objects" gets "backup_store_id"
-- (where its backup copy is; null: none) and "copy_failures". The three "store_id" defaults the
-- release before this one added for containers older than itself are dropped: from here on every
-- insert names its store, and an insert from a container older than the stores release fails
-- (NOT NULL) instead of silently meaning the environment's primary. Do not run this while such a
-- container is still running.
--
-- Locks, all held until drizzle's single transaction commits: ACCESS EXCLUSIVE on "drive_objects",
-- "drive_uploads" and "drive_object_deletions", in that order, which is the order live writes
-- take them in. On the first two nothing is rewritten or scanned: a nullable column, a column
-- with a constant default and DROP DEFAULT are catalog changes, and the new foreign key is added
-- NOT VALID. The outbox is the exception: its new primary key and the partial index on
-- "object_key" are built under that lock, each one pass over the table. Nothing but a purge, the
-- worker's deletion and sweep jobs and a report's evidence copy touches the outbox; uploads and
-- downloads never do. Every new constraint is NOT VALID here, so none reads a row under these
-- locks. The step that runs after the migration (src/after-migrate.ts) validates them, validates
-- the constraints earlier releases left unvalidated, and builds "drive_objects_store_idx"
-- CONCURRENTLY: each in a transaction of its own, under a lock that blocks no read and no write.
-- Each statement waits at most five seconds for a lock and fails, to be retried, rather than
-- queue every Drive request behind this migration.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "drive_objects" ADD COLUMN "backup_store_id" uuid;--> statement-breakpoint
ALTER TABLE "drive_objects" ADD COLUMN "copy_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "drive_objects" ALTER COLUMN "store_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "drive_objects" ADD CONSTRAINT "drive_objects_backup_store_id_object_stores_id_fkey" FOREIGN KEY ("backup_store_id") REFERENCES "object_stores"("id") NOT VALID;--> statement-breakpoint
ALTER TABLE "drive_uploads" ALTER COLUMN "store_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "drive_object_deletions" ADD COLUMN "reason" text DEFAULT 'purged' NOT NULL;--> statement-breakpoint
ALTER TABLE "drive_object_deletions" ADD COLUMN "backup_store_id" uuid;--> statement-breakpoint
ALTER TABLE "drive_object_deletions" ADD COLUMN "export_store_id" uuid;--> statement-breakpoint
ALTER TABLE "drive_object_deletions" ADD COLUMN "export_last_seq" bigint;--> statement-breakpoint
ALTER TABLE "drive_object_deletions" ADD COLUMN "held_by_move" uuid;--> statement-breakpoint
ALTER TABLE "drive_object_deletions" ADD COLUMN "not_before" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drive_object_deletions" ADD COLUMN "backup_left" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "drive_object_deletions" ADD COLUMN "attention" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "drive_object_deletions" ADD COLUMN "failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "drive_object_deletions" ADD COLUMN "failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drive_object_deletions" ALTER COLUMN "store_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "drive_object_deletions" DROP CONSTRAINT "drive_object_deletions_pkey", ADD PRIMARY KEY ("object_id","store_id");--> statement-breakpoint
CREATE INDEX "drive_object_deletions_key_idx" ON "drive_object_deletions" ("object_key") WHERE done_at is null;--> statement-breakpoint
ALTER TABLE "drive_object_deletions" ADD CONSTRAINT "drive_object_deletions_backup_store_id_object_stores_id_fkey" FOREIGN KEY ("backup_store_id") REFERENCES "object_stores"("id") NOT VALID;--> statement-breakpoint
ALTER TABLE "drive_object_deletions" ADD CONSTRAINT "drive_object_deletions_reason_valid" CHECK ("reason" in ('purged', 'moved', 'stray')) NOT VALID;--> statement-breakpoint
ALTER TABLE "drive_object_deletions" ADD CONSTRAINT "drive_object_deletions_hold_valid" CHECK ("held_by_move" is null or "reason" = 'moved') NOT VALID;--> statement-breakpoint
ALTER TABLE "drive_object_deletions" ADD CONSTRAINT "drive_object_deletions_values_valid" CHECK ("failures" >= 0 and (not "backup_left" or "done_at" is not null)) NOT VALID;--> statement-breakpoint
UPDATE "drive_sweeps" SET "name" = 'orphans/00000000-0000-4000-8000-000000000001' WHERE "name" = 'orphans' AND NOT EXISTS (SELECT 1 FROM "drive_sweeps" WHERE "name" = 'orphans/00000000-0000-4000-8000-000000000001');
