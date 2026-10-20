-- Hand-edited (this header and the lock timeout). A dissolved family's records are purged 30 days
-- after it is dissolved (groups.purge-dissolved), but its billing records are kept for accounting:
-- the two group billing tables lose their cascading foreign key to `groups` and keep the group's
-- id only, as personal_plan_endings does. Dropping a foreign key locks both tables briefly; nothing
-- is scanned or rewritten. Waits at most five seconds.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "group_billing_customers" DROP CONSTRAINT "group_billing_customers_group_id_groups_id_fkey";--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" DROP CONSTRAINT "group_billing_subscriptions_group_id_groups_id_fkey";
