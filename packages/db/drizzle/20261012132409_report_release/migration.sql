ALTER TABLE "drive_reports" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
-- Reports closed without a hold are released today; record it, and drop what a release now deletes.
UPDATE "drive_reports" SET "released_at" = coalesce("resolved_at", now()), "reporter_address_hash" = NULL, "reporter_email" = NULL, "uploader_email" = NULL WHERE "status" <> 'open' AND "held_at" IS NULL;--> statement-breakpoint
DELETE FROM "drive_report_keys" WHERE "report_id" IN (SELECT "id" FROM "drive_reports" WHERE "released_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "drive_reports" ADD CONSTRAINT "drive_reports_release_valid" CHECK ("released_at" is null or ("status" <> 'open' and "held_at" is null));
