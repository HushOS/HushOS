-- Hand-edited (this header and the lock timeout). Ending a pooled family member's personal plan
-- (docs/families-shared-pool.md 5.1): two new, empty tables, the second's foreign key pointing
-- only at the first, so no existing table is locked, rewritten or scanned. Each statement waits
-- at most five seconds for a lock and fails, to be retried, rather than queue behind one.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "personal_plan_endings" (
	"subscription_id" text PRIMARY KEY,
	"user_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"admitted_at" timestamp with time zone NOT NULL,
	"pooled_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_plan_endings_outcome_valid" CHECK ("outcome" is null or "outcome" in ('settled', 'dropped', 'ended'))
);
--> statement-breakpoint
CREATE TABLE "personal_plan_refunds" (
	"order_id" text PRIMARY KEY,
	"subscription_id" text NOT NULL,
	"refund_key" text NOT NULL UNIQUE,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"status" text NOT NULL,
	"provider_refund_id" text,
	"failures" integer DEFAULT 0 NOT NULL,
	"owed_since" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "personal_plan_refunds_valid" CHECK ("status" in ('requested', 'pending', 'succeeded', 'failed', 'none') and "amount" >= 0 and "failures" >= 0)
);
--> statement-breakpoint
CREATE INDEX "personal_plan_endings_user_idx" ON "personal_plan_endings" ("user_id");--> statement-breakpoint
CREATE INDEX "personal_plan_endings_open_idx" ON "personal_plan_endings" ("user_id") WHERE "outcome" is null;--> statement-breakpoint
CREATE INDEX "personal_plan_refunds_subscription_idx" ON "personal_plan_refunds" ("subscription_id");--> statement-breakpoint
ALTER TABLE "personal_plan_refunds" ADD CONSTRAINT "personal_plan_refunds_subscription_fk" FOREIGN KEY ("subscription_id") REFERENCES "personal_plan_endings"("subscription_id") ON DELETE CASCADE;