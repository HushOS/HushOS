-- Family tiers (PR #65). This replaces 20261017234809, 20261018002318, 20261018004401,
-- 20261018010343, 20261018011558, 20261018013257 and 20261018015107 (all named group_plan_tiers),
-- which were never merged: a local database that ran any of them must be reset (drop it, or those
-- columns of group_billing_subscriptions and the drizzle.__drizzle_migrations row) before migrating.
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "pending_product_id" text;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "intended_product_id" text;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "intended_product_stale" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "paid_product_id" text;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "paid_quota_bytes" bigint;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "tier_mismatch_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "reissued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "reissued_state" text;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "reissue_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "reissue_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "reissue_gave_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "reissue_stuck_reason" text;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "change_claim_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "uncredited_order_ids" text[];--> statement-breakpoint
-- Rows from before: what they hold is what was paid for, unless no place was (paid_units = 0).
UPDATE "group_billing_subscriptions" SET
    "paid_product_id" = CASE WHEN "paid_units" = 0 THEN NULL ELSE "product_id" END,
    "paid_quota_bytes" = CASE WHEN "paid_units" = 0 THEN 0 ELSE "quota_bytes" END;
