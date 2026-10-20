-- Hand-edited (this header and the lock timeout). A dissolved family's plan is set to end at its
-- period's end by the worker (billing.cancel-dissolved), again whenever its payer resumes it: how
-- many times and when, the period its payer was last emailed about, and a refusal at Polar (when,
-- its code, and the plan's state then). The integer's constant default is added without rewriting
-- the table; the lock on it lasts milliseconds. Waits at most five seconds.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "dissolve_cancels" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "dissolve_cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "dissolve_mailed_period_end" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "dissolve_refused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "dissolve_refusal" text;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "dissolve_refused_state" text;
