-- Hand-edited (this header, the lock timeout and NOT VALID). Roster format 2
-- (docs/groups-design.md 2.10): "workspaces.deleted_at" for deleting a family folder, and
-- "group_area_commitments", every area and root commitment a stored roster lists, refused
-- across groups. The column is nullable with no default, so adding it rewrites nothing, and every
-- existing row is null, which the new check allows; the check is added NOT VALID so the table is
-- not scanned under the lock, and a later release validates it. The partial index holds no row
-- yet; building it reads "workspaces" once (one row per account and per family folder) while
-- drizzle's single transaction holds the lock. The new table starts empty: groups have never been
-- on (GROUPS_ENABLED), so no stored roster's commitments are missing from it; a deployment that
-- turned groups on early has its earlier commitments unrecorded, and reuse of those is not refused.
-- Each statement waits at most five seconds for its lock and fails, to be retried, rather than
-- queue requests behind it.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "group_area_commitments" (
	"commitment" bytea PRIMARY KEY,
	"group_id" uuid NOT NULL,
	"roster_version" integer NOT NULL,
	CONSTRAINT "group_area_commitments_valid" CHECK (octet_length("commitment") = 32)
);
--> statement-breakpoint
ALTER TABLE "group_area_commitments" ADD CONSTRAINT "group_area_commitments_group_id_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "workspaces_deleted_idx" ON "workspaces" ("deleted_at") WHERE "deleted_at" is not null;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_deleted_valid" CHECK ("deleted_at" is null or "group_id" is not null) NOT VALID;
