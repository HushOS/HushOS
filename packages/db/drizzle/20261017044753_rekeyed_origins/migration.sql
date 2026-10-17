-- Hand-edited (this header, the lock timeout and NOT VALID). Re-keyed records (docs/integrity-design.md,
-- "Re-keyed records"): the origin columns are nullable with no default, so adding them rewrites
-- nothing, and every existing row is all null, which the new checks allow; they are added NOT VALID
-- so neither table is scanned under the lock, and the signature checks are replaced the same way
-- (each is looser than the one it replaces for rows with a re-key signature, which no row has yet,
-- and refuses a signer without a signature, which no write makes). A later release validates all
-- four. The ALTERs lock drive_nodes and file_versions, every Drive request's tables, until
-- drizzle's single transaction commits: milliseconds, since nothing is rebuilt. Each waits at most
-- five seconds for its lock and fails, to be retried, rather than queue requests behind it.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
ALTER TABLE "drive_nodes" ADD COLUMN "metadata_origin_envelope" bytea;--> statement-breakpoint
ALTER TABLE "drive_nodes" ADD COLUMN "metadata_origin_key_envelope" bytea;--> statement-breakpoint
ALTER TABLE "drive_nodes" ADD COLUMN "metadata_origin_signer" uuid;--> statement-breakpoint
ALTER TABLE "drive_nodes" ADD COLUMN "metadata_origin_signature" bytea;--> statement-breakpoint
ALTER TABLE "drive_nodes" ADD COLUMN "metadata_rekey_signature" bytea;--> statement-breakpoint
ALTER TABLE "file_versions" ADD COLUMN "origin_envelope" bytea;--> statement-breakpoint
ALTER TABLE "file_versions" ADD COLUMN "origin_key_envelope" bytea;--> statement-breakpoint
ALTER TABLE "file_versions" ADD COLUMN "origin_signer" uuid;--> statement-breakpoint
ALTER TABLE "file_versions" ADD COLUMN "origin_signature" bytea;--> statement-breakpoint
ALTER TABLE "file_versions" ADD COLUMN "rekey_signature" bytea;--> statement-breakpoint
ALTER TABLE "drive_nodes" ADD CONSTRAINT "drive_nodes_origin_valid" CHECK (("metadata_origin_envelope" is null and "metadata_origin_key_envelope" is null and "metadata_origin_signer" is null and "metadata_origin_signature" is null and "metadata_rekey_signature" is null) or ("metadata_origin_envelope" is not null and "metadata_origin_key_envelope" is not null and "metadata_origin_signature" is not null and "metadata_rekey_signature" is not null and "metadata_envelope" is not null and octet_length("metadata_origin_envelope") between 42 and 4136 and octet_length("metadata_origin_key_envelope") = 72 and octet_length("metadata_origin_signature") = 64 and octet_length("metadata_rekey_signature") = 64)) NOT VALID;--> statement-breakpoint
ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_origin_valid" CHECK (("origin_envelope" is null and "origin_key_envelope" is null and "origin_signer" is null and "origin_signature" is null and "rekey_signature" is null) or ("origin_envelope" is not null and "origin_key_envelope" is not null and "origin_signature" is not null and "rekey_signature" is not null and "content_key_envelope" is not null and octet_length("origin_envelope") in (72, 84) and octet_length("origin_envelope") = octet_length("content_key_envelope") and octet_length("origin_key_envelope") = 72 and octet_length("origin_signature") = 64 and octet_length("rekey_signature") = 64)) NOT VALID;--> statement-breakpoint
ALTER TABLE "drive_nodes" DROP CONSTRAINT "drive_nodes_signature_valid", ADD CONSTRAINT "drive_nodes_signature_valid" CHECK (("metadata_signature" is null and ("metadata_signer" is null or "metadata_rekey_signature" is not null)) or ("metadata_signature" is not null and octet_length("metadata_signature") = 64 and "metadata_envelope" is not null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "file_versions" DROP CONSTRAINT "file_versions_signature_valid", ADD CONSTRAINT "file_versions_signature_valid" CHECK (("signature" is null and ("signer" is null or "rekey_signature" is not null)) or ("signature" is not null and octet_length("signature") = 64 and "content_key_envelope" is not null)) NOT VALID;
