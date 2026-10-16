-- Hand-edited. drizzle runs every pending migration in one transaction, so the exclusive lock the
-- first ALTER takes on "workspaces" is held until the run commits, and it blocks reads of the table
-- as well as writes (every Drive request touches it). The column additions are metadata-only, and
-- the CHECK constraints are added NOT VALID (every existing row satisfies them by construction:
-- personal, no group, no area, version 1 or more), so they scan nothing; the next release
-- validates them under a lighter lock. The UNIQUE constraint still builds an index under the lock.
-- lock_timeout bounds the wait for it: the migration fails and is retried rather than queue every
-- request behind a long transaction.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
-- Every workspace so far is a person's: refused outright if any has no personal_workspaces row,
-- checked first with a plain read (no lock beyond what any reader takes), so a refusal never holds
-- the exclusive lock. Sign-up writes a workspace and its personal row in one transaction, so none
-- can appear between this check and the ALTER below.
DO $$
DECLARE orphans bigint;
BEGIN
	SELECT count(*) INTO orphans FROM "workspaces" w
	WHERE NOT EXISTS (SELECT 1 FROM "personal_workspaces" p WHERE p."workspace_id" = w."id");
	IF orphans > 0 THEN
		RAISE EXCEPTION 'workspace_owners: % workspace(s) have no personal_workspaces row; assign or delete them before migrating', orphans;
	END IF;
END $$;--> statement-breakpoint
-- A constant default makes this metadata-only (no table rewrite). The default keeps a container of
-- the previous release, which inserts no owner kind, able to sign people up during a rolling update;
-- this release's own inserts name the owner kind, so the next release can drop the default and no
-- later code path can create a workspace labelled personal without saying so.
ALTER TABLE "workspaces" ADD COLUMN "owner_kind" text DEFAULT 'personal' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "group_id" uuid;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "area_kind" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "id_seed" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "workspace_key_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
-- The workspace key version lived only on each grant; the workspace takes the highest of them.
UPDATE "workspaces" SET "workspace_key_version" = k."version"
FROM (SELECT "workspace_id", max("workspace_key_version") AS "version" FROM "workspace_keys" GROUP BY "workspace_id") k
WHERE k."workspace_id" = "workspaces"."id" AND k."version" > 1;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "rotation_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_id_group" UNIQUE("id","group_id");--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_kind_valid" CHECK ("owner_kind" in ('personal', 'group')) NOT VALID;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_valid" CHECK (("owner_kind" = 'group') = ("group_id" is not null) and ("area_kind" is not null) = ("group_id" is not null) and ("id_seed" is not null) = ("group_id" is not null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_area_valid" CHECK (("area_kind" is null or "area_kind" = 'shared') and ("id_seed" is null or "id_seed" ~ '^[A-Za-z0-9_-]{22}$') and "workspace_key_version" > 0) NOT VALID;
