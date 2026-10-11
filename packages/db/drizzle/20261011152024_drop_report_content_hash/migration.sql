ALTER TABLE "drive_reports" DROP CONSTRAINT "drive_reports_values_valid", ADD CONSTRAINT "drive_reports_values_valid" CHECK ("key_epoch" >= 1 and char_length("reason") between 1 and 2000 and ("reporter_email" is null or char_length("reporter_email") <= 254) and ("reporter_address_hash" is null or octet_length("reporter_address_hash") = 32) and "item_count" >= 0 and ("filed_with" is null or char_length("filed_with") <= 200) and ("filed_reference" is null or char_length("filed_reference") <= 200));--> statement-breakpoint
ALTER TABLE "drive_reports" DROP COLUMN "content_hash";--> statement-breakpoint
-- Reports already closed without a hold give up their operator keys, as closing one now does.
DELETE FROM "drive_report_keys" WHERE "report_id" IN (SELECT "id" FROM "drive_reports" WHERE "status" <> 'open' AND "held_at" IS NULL);--> statement-breakpoint
-- Addresses were kept as plain SHA-256, which the IPv4 space undoes; new ones are keyed.
UPDATE "drive_reports" SET "reporter_address_hash" = NULL;
