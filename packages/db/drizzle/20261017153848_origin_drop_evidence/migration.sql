-- Hand-edited (this header, the lock timeout and NOT VALID). Drop evidence that rebuilds the
-- previous re-keyer's statement (docs/integrity-design.md, "What the server enforces"): the
-- envelope they sealed, its key epoch, and the node's kind or the version's object and suite,
-- which the drop overwrites or a later purge takes. The columns are nullable with no default, so
-- adding them rewrites nothing; every existing row is all null, which the check allows (drops
-- recorded before this release keep no previous envelope). The check is added NOT VALID so the
-- table is not scanned under the lock; a later release validates it. The ALTERs lock
-- drive_origin_drops, written only by rotations that drop an origin in a family folder, until
-- drizzle's single transaction commits: milliseconds. Each waits at most five seconds for its
-- lock and fails, to be retried, rather than queue requests behind it.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "drive_origin_drops" ADD COLUMN "previous_envelope" bytea;--> statement-breakpoint
ALTER TABLE "drive_origin_drops" ADD COLUMN "previous_key_epoch" integer;--> statement-breakpoint
ALTER TABLE "drive_origin_drops" ADD COLUMN "node_kind" text;--> statement-breakpoint
ALTER TABLE "drive_origin_drops" ADD COLUMN "object_id" uuid;--> statement-breakpoint
ALTER TABLE "drive_origin_drops" ADD COLUMN "content_suite" smallint;--> statement-breakpoint
ALTER TABLE "drive_origin_drops" ADD CONSTRAINT "drive_origin_drops_previous_valid" CHECK (("previous_envelope" is null and "previous_key_epoch" is null and "node_kind" is null and "object_id" is null and "content_suite" is null) or ("previous_envelope" is not null and "previous_key_epoch" is not null and "previous_key_epoch" >= 1 and "previous_key_epoch" < "target_epoch" and (("metadata_version" is not null and "node_kind" is not null and "node_kind" in ('folder', 'file') and "object_id" is null and "content_suite" is null and octet_length("previous_envelope") between 42 and 4136) or ("version_id" is not null and "node_kind" is null and "object_id" is not null and "content_suite" is not null and (("content_suite" = 1 and octet_length("previous_envelope") = 72) or ("content_suite" in (2, 3) and octet_length("previous_envelope") = 84)) and octet_length("previous_envelope") = octet_length("origin_envelope"))))) NOT VALID;
