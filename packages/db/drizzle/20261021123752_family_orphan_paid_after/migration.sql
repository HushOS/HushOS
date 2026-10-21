-- Hand-edited (this header and the lock timeout). A deleted family's plan that Polar bills again
-- (reinstated or resumed after the family was purged) is revoked, and every order of it paid at or
-- after `paid_after` is refunded whole: that plan's own first recorded end, written once with the
-- ending and never recomputed. Null on every other ending.
--
-- Runs in drizzle's one transaction and takes personal_plan_endings' ACCESS EXCLUSIVE lock until it
-- commits, which blocks reads of the table as well as writes: a nullable column with no default
-- changes only the catalog, so nothing is scanned or rewritten; milliseconds (the table was empty
-- on hushos.com on 2026-10-21). Reads and writes of the table (the plan-ending job, a lapsed revoke,
-- the operator page) wait for it meanwhile. Waits at most five seconds for the lock.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "personal_plan_endings" ADD COLUMN "paid_after" timestamp with time zone;
