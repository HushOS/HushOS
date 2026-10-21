-- Hand-edited (this header and the lock timeout). A personal plan ending without a family: an
-- unpaid, incomplete or paused personal plan HushOS revoked itself (before a new checkout, or
-- when its owner's files joined a family's pool) is recorded as an ending with no group, so a
-- payment Polar takes for it afterwards is refunded whole by the plan-ending job. Dropping NOT
-- NULL changes only the catalog: no scan, no rewrite, the lock lasts milliseconds. Waits at most
-- five seconds.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "personal_plan_endings" ALTER COLUMN "group_id" DROP NOT NULL;
