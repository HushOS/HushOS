-- Hand-edited (this header, the lock timeout and the two updates). A dissolved family's records are
-- purged 30 days after it is dissolved (groups.purge-dissolved), but its billing records are kept
-- for accounting: the two group billing tables lose their cascading foreign key to `groups` and
-- keep the group's id only, as personal_plan_endings does. Dropping a foreign key locks both
-- tables briefly; nothing is scanned or rewritten.
--
-- Families dissolved before this release were told nothing deletes them, so their 30 days start
-- at the upgrade, never at the dissolve: their live folders are retired now (Drive's purge takes
-- them 30 days later) and their dissolve time becomes now (their records go after that, once no
-- folder is left). Only dissolved families' rows are touched. Waits at most five seconds.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "group_billing_customers" DROP CONSTRAINT "group_billing_customers_group_id_groups_id_fkey";--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" DROP CONSTRAINT "group_billing_subscriptions_group_id_groups_id_fkey";--> statement-breakpoint
UPDATE "workspaces" SET "deleted_at" = now(), "rotation_due_at" = NULL FROM "groups" WHERE "workspaces"."group_id" = "groups"."id" AND "groups"."dissolved_at" IS NOT NULL AND "workspaces"."deleted_at" IS NULL;--> statement-breakpoint
UPDATE "groups" SET "dissolved_at" = now() WHERE "dissolved_at" IS NOT NULL AND "dissolved_at" < now();
