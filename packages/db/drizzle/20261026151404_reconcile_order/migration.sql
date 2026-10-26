-- Hand-edited (this header and the lock timeout). Readings of Polar are numbered in the order
-- they are taken (`billing_reading_seq`, CACHE 1 so every connection draws from one counter):
-- the newest reconcile written for a person or a family (`reconciled_from`), the newest change
-- written for any of a family's plans (`group_billing_customers.changed_from`) and for each plan
-- (`group_billing_subscriptions.changed_from`). A reconcile or change numbered before the newest
-- written writes nothing, so an older reading of Polar never replaces a newer one. A number, not
-- a time, so no clock can reorder them. With a split-role setup, the default privileges in
-- docs/self-hosting.md give the app and worker roles USAGE on the new sequence (nextval).
--
-- Runs in drizzle's one transaction and takes ACCESS EXCLUSIVE locks on billing_customers,
-- group_billing_customers and group_billing_subscriptions until it commits, which block reads of
-- all three as well as writes. The nullable columns change only the catalog: nothing is scanned or
-- rewritten; milliseconds. Waits at most five seconds for each lock.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE SEQUENCE "public"."billing_reading_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
ALTER TABLE "billing_customers" ADD COLUMN "reconciled_from" bigint;--> statement-breakpoint
ALTER TABLE "group_billing_customers" ADD COLUMN "reconciled_from" bigint;--> statement-breakpoint
ALTER TABLE "group_billing_customers" ADD COLUMN "changed_from" bigint;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "changed_from" bigint;
