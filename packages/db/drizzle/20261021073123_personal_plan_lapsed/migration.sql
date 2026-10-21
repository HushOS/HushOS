-- Hand-edited (this header, the lock timeout and the statement order). A personal plan ending
-- without a family: an unpaid, incomplete or paused personal plan HushOS revokes itself (before a
-- new checkout, or when its owner's files join a family's pool) is recorded as an ending with no
-- group, so a payment Polar takes for it afterwards is refunded whole by the plan-ending job. A
-- refund row may be `rewards_pending`: a payment on such a plan whose revoke never landed, its
-- owner's, its commission and referral reward still to grant.
--
-- Both statements run in drizzle's one transaction and each takes its table's ACCESS EXCLUSIVE
-- lock until it commits: dropping NOT NULL changes only the catalog, and the column has a
-- constant default, so nothing is scanned or rewritten; milliseconds on small tables (both empty
-- on hushos.com on 2026-10-21). Endings are locked before refunds, the order the payment note
-- takes them. A refund insert takes them the other way round (refunds, then its foreign key's
-- check on endings), so one landing at that instant can deadlock with this migration: Postgres
-- aborts one of the two, and running the migration again finishes it. Waits at most five seconds
-- for a lock.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "personal_plan_endings" ALTER COLUMN "group_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "personal_plan_refunds" ADD COLUMN "rewards_pending" boolean DEFAULT false NOT NULL;
