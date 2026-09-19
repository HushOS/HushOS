CREATE TABLE "drive_share_events" (
	"share_id" uuid,
	"change_seq" bigint,
	"node_id" uuid NOT NULL,
	"kind" text NOT NULL,
	CONSTRAINT "drive_share_events_pkey" PRIMARY KEY("share_id","change_seq"),
	CONSTRAINT "drive_share_events_kind_valid" CHECK ("kind" in ('entered', 'left'))
);
--> statement-breakpoint
ALTER TABLE "drive_share_events" ADD CONSTRAINT "drive_share_events_share_id_drive_shares_id_fkey" FOREIGN KEY ("share_id") REFERENCES "drive_shares"("id") ON DELETE CASCADE;