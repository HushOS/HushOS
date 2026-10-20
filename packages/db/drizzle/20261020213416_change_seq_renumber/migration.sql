-- Hand-written (custom migration: no schema change). Before this release a batch of folders
-- (POST /drive/folders: the create-folder dialog's "one/two/three" paths) took one change_seq for
-- every folder in it. The change feed pages on change_seq alone and its cursor is the last one
-- served, so a page that ended inside such a batch made the next page skip the rest of it, every
-- time: those folders never reached a device that pulled across that boundary, nor anything filed
-- under them. Batches now take one number per folder.
--
-- Rows that still share a number are given new ones at the head of their workspace, as if each
-- had just changed: a device whose cursor has passed them (and may have skipped some) receives
-- them again, which it applies as it applies any change, and nothing is lost to one that has
-- not. Each workspace's rows are numbered from its own counter, which moves up by as many;
-- within a batch, parents come before children (a parent's height bound is above its child's).
-- Numbers only grow, so no cursor is sent back over a tombstone and tombstones_dropped_through is
-- untouched; tombstones never share a number (a purge takes its own). A rotation step that read
-- one of these folders before the upgrade is refused as stale for it, as after any other change.
-- Only rows that still share a number move, so running this again changes nothing. Containers of
-- the previous release keep writing shared numbers until they stop; the next release runs this
-- again and then makes the index unique.
--
-- Locks: no table lock and no schema change. What keeps the new numbers unique is that every
-- number comes from the workspace's counter (nextChangeSeq and moreChangeSeqs, under the workspace
-- row), which this moves past the numbers it hands out. The first statement locks, FOR UPDATE and
-- in id order, the workspaces rows of the workspaces that have a shared number, so that no number
-- is taken in them meanwhile: writes that number nodes in those workspaces wait until drizzle's
-- single transaction commits, the time of two scans of drive_nodes' numbered rows and the update of
-- the rows that move. Not every write takes that row (an upload's first step inserts its node
-- without a number); none of those number a node. Reads, sign-ups and every other workspace go on.
-- It waits at most five seconds for a row and fails, to be retried, rather than queue requests
-- behind it. A deadlock aborts it with nothing applied, to be run again: the tombstone sweep
-- deletes drive_nodes rows before updating workspaces, and a move between a family folder and a
-- personal workspace locks the family folder's row first, not in id order.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
SELECT 1 FROM "workspaces"
WHERE "id" IN (
	SELECT "workspace_id" FROM "drive_nodes"
	WHERE "change_seq" IS NOT NULL
	GROUP BY "workspace_id", "change_seq"
	HAVING count(*) > 1
)
ORDER BY "id"
FOR UPDATE;--> statement-breakpoint
WITH "shared" AS (
	SELECT "workspace_id", "change_seq" FROM "drive_nodes"
	WHERE "change_seq" IS NOT NULL
	GROUP BY "workspace_id", "change_seq"
	HAVING count(*) > 1
), "members" AS (
	SELECT "n"."id", "n"."workspace_id",
		row_number() OVER (PARTITION BY "n"."workspace_id" ORDER BY "n"."change_seq", "n"."height_bound" DESC, "n"."id") AS "k"
	FROM "drive_nodes" "n"
	JOIN "shared" "s" ON "s"."workspace_id" = "n"."workspace_id" AND "s"."change_seq" = "n"."change_seq"
), "counts" AS (
	SELECT "workspace_id", count(*) AS "n" FROM "members" GROUP BY "workspace_id"
), "heads" AS (
	UPDATE "workspaces" "w" SET "change_seq" = "w"."change_seq" + "c"."n"
	FROM "counts" "c" WHERE "w"."id" = "c"."workspace_id"
	RETURNING "w"."id", "w"."change_seq" AS "head", "c"."n"
)
UPDATE "drive_nodes" "d" SET "change_seq" = "h"."head" - "h"."n" + "m"."k"
FROM "members" "m" JOIN "heads" "h" ON "h"."id" = "m"."workspace_id"
WHERE "d"."id" = "m"."id";
