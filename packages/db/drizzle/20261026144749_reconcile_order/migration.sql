-- Hand-edited (this header and the lock timeout). When the newest reconcile written for a person
-- or a family began reading Polar (`reconciled_from`), and when the newest change written for a
-- family's plan was answered (`changed_from`), both by the database's clock: a reconcile that
-- began earlier and commits later writes nothing, so an older reading of Polar never replaces a
-- newer one.
--
-- Runs in drizzle's one transaction and takes ACCESS EXCLUSIVE locks on billing_customers and
-- group_billing_customers until it commits, which block reads of both tables as well as writes.
-- The nullable columns change only the catalog: nothing is scanned or rewritten; milliseconds.
-- Waits at most five seconds for each lock.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "billing_customers" ADD COLUMN "reconciled_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "group_billing_customers" ADD COLUMN "reconciled_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "group_billing_customers" ADD COLUMN "changed_from" timestamp with time zone;
