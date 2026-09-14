CREATE TABLE "drive_report_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"report_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"urls" jsonb,
	"url_expires_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone,
	CONSTRAINT "drive_report_requests_status_valid" CHECK ("status" in ('pending', 'ready', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "drive_report_items" ADD COLUMN "thumbnail_object_id" uuid;--> statement-breakpoint
ALTER TABLE "drive_report_items" ADD COLUMN "thumbnail_object_key" text;--> statement-breakpoint
ALTER TABLE "drive_report_items" ADD COLUMN "thumbnail_nonce" bytea;--> statement-breakpoint
ALTER TABLE "drive_report_items" ADD COLUMN "thumbnail_plaintext_size" bigint;--> statement-breakpoint
CREATE INDEX "drive_report_items_thumbnail_idx" ON "drive_report_items" ("thumbnail_object_id");--> statement-breakpoint
CREATE INDEX "drive_report_requests_pending_idx" ON "drive_report_requests" ("created_at") WHERE status = 'pending';--> statement-breakpoint
ALTER TABLE "drive_report_requests" ADD CONSTRAINT "drive_report_requests_report_id_drive_reports_id_fkey" FOREIGN KEY ("report_id") REFERENCES "drive_reports"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "drive_report_items" DROP CONSTRAINT "drive_report_items_valid", ADD CONSTRAINT "drive_report_items_valid" CHECK ("depth" >= 0 and "key_epoch" >= 1 and "parent_key_epoch" >= 1 and octet_length("key_envelope") = 72 and octet_length("metadata_envelope") between 42 and 4136 and (("kind" = 'folder' and "version_id" is null) or ("kind" = 'file' and ("version_id" is null or ("object_id" is not null and "object_key" is not null and octet_length("content_key_envelope") = 72 and octet_length("content_nonce") = 16 and "chunk_size" > 0 and "chunk_count" >= 1 and "plaintext_size" >= 0 and "ciphertext_size" >= 0)))) and (("thumbnail_object_id" is null and "thumbnail_object_key" is null and "thumbnail_nonce" is null) or ("thumbnail_object_id" is not null and "thumbnail_object_key" is not null and octet_length("thumbnail_nonce") = 16 and "thumbnail_plaintext_size" >= 0)));