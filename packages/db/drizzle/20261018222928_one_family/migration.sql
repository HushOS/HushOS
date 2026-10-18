-- Hand-edited (this header, the lock timeout, the check, the backfill and the default). One family
-- per account (docs/families-shared-pool.md 4): "group_memberships.group_kind", copied from the
-- group and held to it by a composite foreign key (a partial index can't read another table), and
-- a unique index on each account's active family membership. Company memberships are outside it.
--
-- It stops, changing nothing, while any account is active in more than one family: which family
-- to keep is that person's choice, and leaving goes through rules a migration can't keep (the
-- organizer, the payer and the last manager can't simply go: the signed member list depends on
-- them). docs/self-hosting.md (Groups, "One family per account") says how to resolve them.
--
-- The first two ALTERs take ACCESS EXCLUSIVE on groups and then group_memberships (the order every
-- group write takes them in) and hold it to the commit, so nothing changes between the count and
-- the index. The column's default is for containers of the
-- previous release during a rollout, which insert memberships without it; only families can be
-- created, and the foreign key refuses the default for any other kind. A later release drops it.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_id_kind" UNIQUE("id","kind");--> statement-breakpoint
ALTER TABLE "group_memberships" ADD COLUMN "group_kind" text DEFAULT 'family';--> statement-breakpoint
DO $$
DECLARE
    accounts integer;
BEGIN
    SELECT count(*) INTO accounts FROM (
        SELECT m.user_id
        FROM group_memberships m
        JOIN groups g ON g.id = m.group_id
        WHERE g.kind = 'family' AND m.state = 'active'
        GROUP BY m.user_id
        HAVING count(*) > 1
    ) AS duplicated;
    IF accounts > 0 THEN
        RAISE EXCEPTION 'HushOS: % account(s) are in more than one family, and an account can now be in one. Nothing was changed. See docs/self-hosting.md, One family per account.', accounts
            USING HINT = 'List them with: select m.user_id, array_agg(g.name) from group_memberships m join groups g on g.id = m.group_id where g.kind = ''family'' and m.state = ''active'' group by m.user_id having count(*) > 1; have each leave all but one family on the release you run now, then upgrade. See docs/self-hosting.md, Groups.';
    END IF;
END $$;--> statement-breakpoint
UPDATE "group_memberships" AS m SET "group_kind" = g."kind" FROM "groups" AS g WHERE g."id" = m."group_id";--> statement-breakpoint
ALTER TABLE "group_memberships" ALTER COLUMN "group_kind" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_group_kind_fk" FOREIGN KEY ("group_id","group_kind") REFERENCES "groups"("id","kind") ON DELETE CASCADE;--> statement-breakpoint
CREATE UNIQUE INDEX "group_memberships_one_family_idx" ON "group_memberships" ("user_id") WHERE "group_kind" = 'family' and "state" = 'active';
