-- Hand-edited (this header, the lock timeout, and the check added NOT VALID then validated).
-- A personal plan ending without a family: an unpaid, incomplete or paused personal plan HushOS
-- revokes itself (before a new checkout, or when its owner's files join a family's pool) is
-- recorded as an ending with no group, so a payment Polar takes for it afterwards is refunded
-- whole by the plan-ending job. A refund row may also be `kept`: a payment on such a plan whose
-- revoke never landed, its owner's, with its commission and referral reward still to grant.
-- Dropping NOT NULL changes only the catalog. The check is replaced NOT VALID (no scan under the
-- table lock) and then validated, which reads the table under a lock that lets writes go on:
-- personal_plan_refunds is small (empty on hushos.com on 2026-10-21). Waits at most five seconds.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "personal_plan_endings" ALTER COLUMN "group_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_plan_refunds" DROP CONSTRAINT "personal_plan_refunds_valid", ADD CONSTRAINT "personal_plan_refunds_valid" CHECK ("status" in ('requested', 'pending', 'succeeded', 'failed', 'none', 'disputed', 'kept') and "amount" >= 0 and "failures" >= 0) NOT VALID;--> statement-breakpoint
ALTER TABLE "personal_plan_refunds" VALIDATE CONSTRAINT "personal_plan_refunds_valid";
