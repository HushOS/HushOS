-- Hand-edited (this header and the lock timeout). Why HushOS couldn't revoke a lapsed family plan
-- (unpaid, incomplete, paused) it set out to end, and when: listed for operators, since a payer's
-- deletion or leave, or a new plan, waits on it. `product_unread`: a family plan on a product the
-- catalogue can't read, recorded as Polar has it but never the family's plan or its payer's.
-- `plans_unlisted_since`: Polar's list of a family's plans is owed (a read failed), retried by the
-- daily reconcile, listed for operators, and the family kept from the purge meanwhile. Rows an
-- earlier build of this change wrote for an unread product (their name set to their product id,
-- which no plan the catalogue reads ever has) are marked unread too.
--
-- Runs in drizzle's one transaction and takes ACCESS EXCLUSIVE locks on group_billing_customers
-- and group_billing_subscriptions until it commits, which block reads of both tables as well as
-- writes. The nullable columns change only the catalog; `product_unread`'s constant default is
-- stored once in the catalog too (PostgreSQL 11 and later); the backfill scans the family
-- subscriptions and rewrites only the rows it marks (none on hushos.com, where families are off).
-- Milliseconds (families are off on hushos.com, the tables are small). Waits at most five
-- seconds for each lock.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "group_billing_customers" ADD COLUMN "plans_unlisted_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "lapsed_revoke_refusal" text;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "lapsed_revoke_refused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "product_unread" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "group_billing_subscriptions" SET "product_unread" = true WHERE "product_name" = "product_id";
