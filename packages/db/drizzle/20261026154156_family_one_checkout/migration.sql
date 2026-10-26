-- Hand-edited (this header and the lock timeout). One plan per family: the one checkout a family
-- may have open at Polar (a new table, so two billing holders or two tabs can't each open one and
-- both pay), a family's second live plan marked superseded while HushOS ends it (with the refund cutoff it was
-- marked with, so every later run ends it from the same one), since when each plan
-- has been the family's (so a plan bought beside it never takes its place), and an affiliate
-- commission already paid out on an order HushOS later refunds whole marked for an operator.
--
-- Runs in drizzle's one transaction. Creating the new table takes no lock on any existing table.
-- The five columns added to affiliate_earnings and group_billing_subscriptions are nullable with
-- no default: only the catalog changes, nothing is scanned or rewritten, but each table's ACCESS
-- EXCLUSIVE lock blocks its reads as well as its writes until the transaction commits
-- (milliseconds; families are off on hushos.com, and affiliate_earnings is small). Waits at most
-- five seconds for each lock. An old web container never reads or writes the new table: it doesn't
-- refuse a second checkout, and its live-plan read doesn't skip a superseded plan; the cure of any
-- reconcile on the new release still keeps one plan.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "group_checkouts" (
	"group_id" uuid PRIMARY KEY,
	"user_id" uuid NOT NULL,
	"token" uuid NOT NULL,
	"product_id" text NOT NULL,
	"terms" text NOT NULL,
	"provider_checkout_id" text,
	"url" text,
	"until" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "affiliate_earnings" ADD COLUMN "order_refunded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "served_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "superseded_by" text;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "superseded_paid_after" timestamp with time zone;