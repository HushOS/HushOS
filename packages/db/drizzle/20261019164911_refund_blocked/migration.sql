-- Hand-edited (this header and the lock timeout). A refund Polar refuses for good is set aside
-- as `blocked` (docs/families-shared-pool.md 5.1): the status check on personal_plan_refunds
-- gains it. Re-adding the check scans the table under its lock, which only the plan-ending job
-- writes and which holds a row per refunded order: milliseconds. Waits at most five seconds.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "personal_plan_refunds" DROP CONSTRAINT "personal_plan_refunds_valid", ADD CONSTRAINT "personal_plan_refunds_valid" CHECK ("status" in ('requested', 'pending', 'succeeded', 'failed', 'none', 'blocked') and "amount" >= 0 and "failures" >= 0);