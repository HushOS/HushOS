-- Hand-edited (this header and the lock timeout). The emails a family's dissolving owes
-- (docs/groups-design.md 3.3): one new, empty table. Its foreign keys to "groups", "users" and
-- "group_invitations" take a SHARE ROW EXCLUSIVE lock on each until drizzle's transaction
-- commits, which blocks writes to them (not reads) for the milliseconds that takes; nothing is
-- scanned or rewritten, since the new table holds no row. Each statement waits at most five
-- seconds for a lock and fails, to be retried, rather than queue behind one.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "group_dissolve_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"group_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"user_id" uuid,
	"invitation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"retry_after" timestamp with time zone,
	CONSTRAINT "group_dissolve_notices_valid" CHECK ("kind" in ('dissolved', 'accepted', 'invited') and ("user_id" is null) = ("invitation_id" is not null) and ("kind" = 'invited') = ("invitation_id" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "group_dissolve_notices_user_idx" ON "group_dissolve_notices" ("user_id","group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "group_dissolve_notices_invitation_idx" ON "group_dissolve_notices" ("invitation_id");--> statement-breakpoint
CREATE INDEX "group_dissolve_notices_due_idx" ON "group_dissolve_notices" ("created_at") WHERE "sent_at" is null;--> statement-breakpoint
CREATE INDEX "group_dissolve_notices_group_idx" ON "group_dissolve_notices" ("group_id");--> statement-breakpoint
ALTER TABLE "group_dissolve_notices" ADD CONSTRAINT "group_dissolve_notices_group_id_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "group_dissolve_notices" ADD CONSTRAINT "group_dissolve_notices_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "group_dissolve_notices" ADD CONSTRAINT "group_dissolve_notices_invitation_id_group_invitations_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "group_invitations"("id") ON DELETE CASCADE;