-- Hand-edited (this header, the lock timeout and the backfill). A deleted family's plan that Polar
-- bills again (reinstated or resumed after the family was purged) is revoked, and every order of it
-- made at or after `paid_after` is refunded whole (compared by the order's `created_at`): the end of
-- the last period that plan gave the family, from `served_until`, or the epoch for one that never
-- served it; written once with the ending and never recomputed. Null on every other ending.
--
-- `served_until`: the end of the last period in which a family's plan was the family's plan while
-- active or trialing, set by every reconcile from now on. Rows already there are filled from what
-- they say: none for a checkout that never completed, the start of the current period for one
-- past due, unpaid or paused (that period gave nothing), otherwise its end (or its own end, if
-- earlier).
--
-- Runs in drizzle's one transaction and takes ACCESS EXCLUSIVE locks on personal_plan_endings and
-- group_billing_subscriptions until it commits, which block reads of both tables as well as writes.
-- The new columns are nullable with no default (only the catalog changes); the backfill rewrites
-- every row of group_billing_subscriptions once (a handful: families are off on hushos.com).
-- Milliseconds. Waits at most five seconds for each lock.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "served_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "personal_plan_endings" ADD COLUMN "paid_after" timestamp with time zone;--> statement-breakpoint
UPDATE "group_billing_subscriptions" SET "served_until" = CASE
	WHEN "status" IN ('incomplete', 'incomplete_expired') THEN NULL
	WHEN "status" IN ('unpaid', 'past_due', 'paused') THEN "current_period_start"
	ELSE LEAST(COALESCE("ended_at", "current_period_end"), "current_period_end")
END;
