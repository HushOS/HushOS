ALTER TABLE "drive_nodes" ADD COLUMN "metadata_signer" uuid;--> statement-breakpoint
ALTER TABLE "drive_nodes" ADD COLUMN "metadata_signature" bytea;--> statement-breakpoint
ALTER TABLE "drive_report_items" ADD COLUMN "metadata_signer" uuid;--> statement-breakpoint
ALTER TABLE "drive_report_items" ADD COLUMN "metadata_signature" bytea;--> statement-breakpoint
ALTER TABLE "drive_report_items" ADD COLUMN "version_signer" uuid;--> statement-breakpoint
ALTER TABLE "drive_report_items" ADD COLUMN "version_signature" bytea;--> statement-breakpoint
ALTER TABLE "file_versions" ADD COLUMN "signer" uuid;--> statement-breakpoint
ALTER TABLE "file_versions" ADD COLUMN "signature" bytea;--> statement-breakpoint
CREATE INDEX "drive_nodes_signer_idx" ON "drive_nodes" ("metadata_signer") WHERE metadata_signer is not null;--> statement-breakpoint
CREATE INDEX "file_versions_signer_idx" ON "file_versions" ("signer") WHERE signer is not null;--> statement-breakpoint
ALTER TABLE "drive_nodes" ADD CONSTRAINT "drive_nodes_metadata_signer_users_id_fkey" FOREIGN KEY ("metadata_signer") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_signer_users_id_fkey" FOREIGN KEY ("signer") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "drive_nodes" ADD CONSTRAINT "drive_nodes_signature_valid" CHECK (("metadata_signature" is null and "metadata_signer" is null) or (octet_length("metadata_signature") = 64 and "metadata_envelope" is not null));--> statement-breakpoint
ALTER TABLE "drive_report_items" ADD CONSTRAINT "drive_report_items_signatures_valid" CHECK (("metadata_signature" is null or octet_length("metadata_signature") = 64) and ("version_signature" is null or octet_length("version_signature") = 64));--> statement-breakpoint
ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_signature_valid" CHECK (("signature" is null and "signer" is null) or (octet_length("signature") = 64 and "content_key_envelope" is not null));