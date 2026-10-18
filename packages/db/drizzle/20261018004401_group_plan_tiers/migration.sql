-- Family tiers (PR #65). This replaces 20261017234809_group_plan_tiers and 20261018002318_group_plan_tiers,
-- which were never merged: a local database that ran either must be reset (drop it, or its
-- group_billing_subscriptions columns and its drizzle.__drizzle_migrations row) before migrating.
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "pending_product_id" text;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "intended_product_id" text;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "intended_product_stale" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "paid_product_id" text;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "paid_quota_bytes" bigint;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "reissued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "reissued_state" text;--> statement-breakpoint
-- Rows from before: what they hold is what was paid for.
UPDATE "group_billing_subscriptions" SET "paid_product_id" = "product_id", "paid_quota_bytes" = "quota_bytes";
