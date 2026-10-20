-- Hand-edited (this header and the lock timeout). A dissolved family's plan is set to end at its
-- period's end by the worker (billing.cancel-dissolved), at most MAX_DISSOLVE_CANCELS times: the
-- count, the last time, and when HushOS gave up. The integer's constant default is added without
-- rewriting the table; the lock on it lasts milliseconds. Waits at most five seconds.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "dissolve_cancels" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "dissolve_cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "dissolve_gave_up_at" timestamp with time zone;
