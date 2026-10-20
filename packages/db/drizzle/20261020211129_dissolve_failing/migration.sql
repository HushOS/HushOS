-- Hand-edited (this header and the lock timeout). When setting a dissolved family's plan to end
-- first failed in a way the worker retries, so one Polar keeps failing (a token error) is listed
-- for operators after a day. A nullable column with no default: no rewrite, the lock lasts
-- milliseconds. Waits at most five seconds.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "dissolve_failing_since" timestamp with time zone;
