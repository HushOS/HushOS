-- The report address key lived beside the hashes it keyed; the server hash key is never stored.
DELETE FROM "server_secrets" WHERE "name" = 'report-address-key';--> statement-breakpoint
-- Hashes under the old key match nothing now, and a dump holding both could undo them.
UPDATE "drive_reports" SET "reporter_address_hash" = NULL WHERE "reporter_address_hash" IS NOT NULL;--> statement-breakpoint
-- Buckets named by a plain hash of an address or an email; they refill within the hour anyway.
DELETE FROM "auth_rate_limits";
