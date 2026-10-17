-- Hand-edited (this header, the lock timeout and NOT VALID). Re-keyed records
-- (docs/integrity-design.md, "Re-keyed records"): the origin and drop columns, and
-- drive_report_items' origin signers, are nullable with no default, so adding them rewrites
-- nothing, and every existing row is all null, which the new checks allow. The checks are added
-- NOT VALID so neither table is scanned under the lock, and the signature checks are replaced the
-- same way: each is looser than the one it replaces for rows with a re-key signature, which no row
-- has yet, and refuses a signer without a signature, which no write makes (check with the query in
-- docs/self-hosting.md). A later release validates all six. The ALTERs lock drive_nodes and
-- file_versions, every Drive request's tables, until drizzle's single transaction commits:
-- milliseconds, since nothing is rebuilt. drive_origin_drops is new and empty; its foreign key
-- takes SHARE ROW EXCLUSIVE on "workspaces" until commit too. Each waits at most five seconds for
-- its lock and fails, to be retried, rather than queue requests behind it.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "drive_origin_drops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"metadata_version" integer,
	"version_id" uuid,
	"origin_signer" uuid NOT NULL,
	"origin_digest" bytea NOT NULL,
	"origin_signature" bytea NOT NULL,
	"dropped_by" uuid NOT NULL,
	"target_epoch" integer NOT NULL,
	"dropped_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drive_origin_drops_valid" CHECK (("metadata_version" is null) <> ("version_id" is null) and octet_length("origin_digest") = 32 and octet_length("origin_signature") = 64 and "target_epoch" >= 1)
);
--> statement-breakpoint
ALTER TABLE "drive_nodes" ADD COLUMN "metadata_origin_envelope" bytea;--> statement-breakpoint
ALTER TABLE "drive_nodes" ADD COLUMN "metadata_origin_key_envelope" bytea;--> statement-breakpoint
ALTER TABLE "drive_nodes" ADD COLUMN "metadata_origin_signer" uuid;--> statement-breakpoint
ALTER TABLE "drive_nodes" ADD COLUMN "metadata_origin_signature" bytea;--> statement-breakpoint
ALTER TABLE "drive_nodes" ADD COLUMN "metadata_rekey_signature" bytea;--> statement-breakpoint
ALTER TABLE "drive_nodes" ADD COLUMN "metadata_dropped_signer" uuid;--> statement-breakpoint
ALTER TABLE "drive_nodes" ADD COLUMN "metadata_origin_dropped_by" uuid;--> statement-breakpoint
ALTER TABLE "drive_report_items" ADD COLUMN "metadata_origin_signer" uuid;--> statement-breakpoint
ALTER TABLE "drive_report_items" ADD COLUMN "version_origin_signer" uuid;--> statement-breakpoint
ALTER TABLE "file_versions" ADD COLUMN "origin_envelope" bytea;--> statement-breakpoint
ALTER TABLE "file_versions" ADD COLUMN "origin_key_envelope" bytea;--> statement-breakpoint
ALTER TABLE "file_versions" ADD COLUMN "origin_signer" uuid;--> statement-breakpoint
ALTER TABLE "file_versions" ADD COLUMN "origin_signature" bytea;--> statement-breakpoint
ALTER TABLE "file_versions" ADD COLUMN "rekey_signature" bytea;--> statement-breakpoint
ALTER TABLE "file_versions" ADD COLUMN "dropped_signer" uuid;--> statement-breakpoint
ALTER TABLE "file_versions" ADD COLUMN "origin_dropped_by" uuid;--> statement-breakpoint
CREATE INDEX "drive_origin_drops_node_idx" ON "drive_origin_drops" ("workspace_id","node_id");--> statement-breakpoint
ALTER TABLE "drive_origin_drops" ADD CONSTRAINT "drive_origin_drops_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "drive_nodes" ADD CONSTRAINT "drive_nodes_dropped_valid" CHECK (("metadata_dropped_signer" is null) = ("metadata_origin_dropped_by" is null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "drive_nodes" ADD CONSTRAINT "drive_nodes_origin_valid" CHECK (("metadata_origin_envelope" is null and "metadata_origin_key_envelope" is null and "metadata_origin_signer" is null and "metadata_origin_signature" is null and "metadata_rekey_signature" is null) or ("metadata_origin_envelope" is not null and "metadata_origin_signer" is not null and "metadata_origin_key_envelope" is not null and "metadata_origin_signature" is not null and "metadata_rekey_signature" is not null and "metadata_envelope" is not null and octet_length("metadata_origin_envelope") between 42 and 4136 and octet_length("metadata_origin_key_envelope") = 72 and octet_length("metadata_origin_signature") = 64 and octet_length("metadata_rekey_signature") = 64)) NOT VALID;--> statement-breakpoint
ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_dropped_valid" CHECK (("dropped_signer" is null) = ("origin_dropped_by" is null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_origin_valid" CHECK (("origin_envelope" is null and "origin_key_envelope" is null and "origin_signer" is null and "origin_signature" is null and "rekey_signature" is null) or ("origin_envelope" is not null and "origin_signer" is not null and "origin_key_envelope" is not null and "origin_signature" is not null and "rekey_signature" is not null and "content_key_envelope" is not null and octet_length("origin_envelope") in (72, 84) and octet_length("origin_envelope") = octet_length("content_key_envelope") and octet_length("origin_key_envelope") = 72 and octet_length("origin_signature") = 64 and octet_length("rekey_signature") = 64)) NOT VALID;--> statement-breakpoint
ALTER TABLE "drive_nodes" DROP CONSTRAINT "drive_nodes_signature_valid", ADD CONSTRAINT "drive_nodes_signature_valid" CHECK (("metadata_signature" is null and ("metadata_signer" is null or "metadata_rekey_signature" is not null)) or ("metadata_signature" is not null and octet_length("metadata_signature") = 64 and "metadata_envelope" is not null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "file_versions" DROP CONSTRAINT "file_versions_signature_valid", ADD CONSTRAINT "file_versions_signature_valid" CHECK (("signature" is null and ("signer" is null or "rekey_signature" is not null)) or ("signature" is not null and octet_length("signature") = 64 and "content_key_envelope" is not null)) NOT VALID;