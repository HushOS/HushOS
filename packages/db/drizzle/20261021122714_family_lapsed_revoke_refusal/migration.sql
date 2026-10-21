-- Hand-edited (this header and the lock timeout). Why HushOS couldn't revoke a lapsed family plan
-- (unpaid, incomplete, paused) it set out to end, and when: listed for operators, since a payer's
-- deletion or leave, or a new plan, waits on it.
--
-- Runs in drizzle's one transaction and takes group_billing_subscriptions' ACCESS EXCLUSIVE lock
-- until it commits, which blocks reads of the table as well as writes: two nullable columns with no
-- default change only the catalog, so nothing is scanned or rewritten; milliseconds (families are
-- off on hushos.com, the table is small). Waits at most five seconds for the lock.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "lapsed_revoke_refusal" text;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD COLUMN "lapsed_revoke_refused_at" timestamp with time zone;