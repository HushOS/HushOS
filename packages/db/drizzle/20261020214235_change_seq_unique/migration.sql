-- Hand-edited (this header, the lock timeout, the locks, the renumbering, and the index built
-- under a temporary name and swapped in). The previous release (20261020213416_change_seq_renumber)
-- gave each folder of a batch its own change_seq and renumbered the rows that shared one; its
-- containers ran beside the release before it, which kept giving a batch one number until it
-- stopped. This renumbers what they wrote, exactly as that migration does (rows that still share a
-- number take new ones at the head of their workspace, parents first; nothing else moves), then
-- makes the index on (workspace_id, change_seq) unique, so that no write can share a number again:
-- the change feeds page on it alone, and a page ending between two rows that shared one made the
-- next page skip the other. Take this only once no container older than the previous release runs:
-- one would have its batches of folders refused.
--
-- Locks, in the order live writes take them: the workspaces rows of the workspaces that still have
-- a shared number (FOR UPDATE, in id order; none, once the previous release has run alone), then
-- drive_nodes in SHARE mode, which lets reads go on and makes every Drive write wait while the rows
-- move and the unique index is built: milliseconds on a small instance, seconds on a large one. The
-- old index is then dropped and the new one renamed in its place, which holds drive_nodes
-- exclusively, reads included, until drizzle's single transaction commits: milliseconds. The drop
-- must first wait for every reader of drive_nodes to finish (share-feed polls, a pg_dump), and
-- every read queues behind it meanwhile, so it waits at most one second; the other locks at most
-- five. A lock not had in time fails the migration, to be retried, rather than queue requests
-- behind it; so does a deadlock with a live write (the tombstone sweep, or a move between a family
-- folder and a personal workspace). Don't run it during the backup window: a pg_dump holds its
-- read until it ends, and the drop would fail every time. Should a number still be shared when
-- the index is built, the build fails and nothing is applied.
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
LOCK TABLE "drive_nodes" IN SHARE MODE;--> statement-breakpoint
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
WHERE "d"."id" = "m"."id";--> statement-breakpoint
CREATE UNIQUE INDEX "drive_nodes_change_uidx" ON "drive_nodes" ("workspace_id","change_seq") WHERE change_seq is not null;--> statement-breakpoint
SET LOCAL lock_timeout = '1s';--> statement-breakpoint
DROP INDEX "drive_nodes_change_idx";--> statement-breakpoint
ALTER INDEX "drive_nodes_change_uidx" RENAME TO "drive_nodes_change_idx";
