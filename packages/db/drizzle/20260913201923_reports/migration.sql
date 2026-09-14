CREATE TABLE "drive_report_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"report_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drive_report_events_valid" CHECK (char_length("action") between 1 and 40 and ("note" is null or char_length("note") <= 2000))
);
--> statement-breakpoint
CREATE TABLE "drive_report_items" (
	"report_id" uuid,
	"node_id" uuid,
	"parent_id" uuid,
	"depth" integer NOT NULL,
	"kind" text NOT NULL,
	"key_epoch" integer NOT NULL,
	"parent_key_epoch" integer NOT NULL,
	"key_envelope" bytea NOT NULL,
	"metadata_version" integer NOT NULL,
	"metadata_envelope" bytea NOT NULL,
	"version_id" uuid,
	"object_id" uuid,
	"object_key" text,
	"content_key_envelope" bytea,
	"content_nonce" bytea,
	"content_suite" smallint,
	"chunk_size" integer,
	"chunk_count" integer,
	"plaintext_size" bigint,
	"ciphertext_size" bigint,
	"evidence_copied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drive_report_items_pkey" PRIMARY KEY("report_id","node_id"),
	CONSTRAINT "drive_report_items_valid" CHECK ("depth" >= 0 and "key_epoch" >= 1 and "parent_key_epoch" >= 1 and octet_length("key_envelope") = 72 and octet_length("metadata_envelope") between 42 and 4136 and (("kind" = 'folder' and "version_id" is null) or ("kind" = 'file' and ("version_id" is null or ("object_id" is not null and "object_key" is not null and octet_length("content_key_envelope") = 72 and octet_length("content_nonce") = 16 and "chunk_size" > 0 and "chunk_count" >= 1 and "plaintext_size" >= 0 and "ciphertext_size" >= 0)))))
);
--> statement-breakpoint
CREATE TABLE "drive_report_keys" (
	"report_id" uuid,
	"operator_user_id" uuid,
	"key_envelope" bytea NOT NULL,
	CONSTRAINT "drive_report_keys_pkey" PRIMARY KEY("report_id","operator_user_id"),
	CONSTRAINT "drive_report_keys_envelope_valid" CHECK (octet_length("key_envelope") = 112)
);
--> statement-breakpoint
CREATE TABLE "drive_reports" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"node_kind" text NOT NULL,
	"key_epoch" integer NOT NULL,
	"link_id" uuid,
	"share_id" uuid,
	"category" text NOT NULL,
	"reason" text NOT NULL,
	"reporter_user_id" uuid,
	"reporter_email" text,
	"reporter_address_hash" bytea,
	"uploader_user_id" uuid,
	"uploader_email" text,
	"content_hash" bytea,
	"status" text DEFAULT 'open' NOT NULL,
	"held_at" timestamp with time zone,
	"evidence_status" text DEFAULT 'pending' NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"items_truncated" boolean DEFAULT false NOT NULL,
	"filed_with" text,
	"filed_reference" text,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drive_reports_category_valid" CHECK ("category" in ('csam', 'terrorism', 'ncii', 'malware', 'copyright', 'harassment', 'other')),
	CONSTRAINT "drive_reports_status_valid" CHECK ("status" in ('open', 'dismissed', 'removed', 'filed')),
	CONSTRAINT "drive_reports_evidence_valid" CHECK ("evidence_status" in ('pending', 'copied', 'skipped', 'failed', 'purged')),
	CONSTRAINT "drive_reports_values_valid" CHECK ("key_epoch" >= 1 and char_length("reason") between 1 and 2000 and ("reporter_email" is null or char_length("reporter_email") <= 254) and ("reporter_address_hash" is null or octet_length("reporter_address_hash") = 32) and ("content_hash" is null or octet_length("content_hash") = 32) and "item_count" >= 0 and ("filed_with" is null or char_length("filed_with") <= 200) and ("filed_reference" is null or char_length("filed_reference") <= 200))
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "drive_nodes" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "drive_report_events_report_idx" ON "drive_report_events" ("report_id","created_at");--> statement-breakpoint
CREATE INDEX "drive_report_items_object_idx" ON "drive_report_items" ("object_id");--> statement-breakpoint
CREATE INDEX "drive_report_items_parent_idx" ON "drive_report_items" ("report_id","parent_id");--> statement-breakpoint
CREATE INDEX "drive_reports_queue_idx" ON "drive_reports" ("status","created_at");--> statement-breakpoint
CREATE INDEX "drive_reports_node_idx" ON "drive_reports" ("node_id");--> statement-breakpoint
ALTER TABLE "drive_report_events" ADD CONSTRAINT "drive_report_events_report_id_drive_reports_id_fkey" FOREIGN KEY ("report_id") REFERENCES "drive_reports"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "drive_report_items" ADD CONSTRAINT "drive_report_items_report_id_drive_reports_id_fkey" FOREIGN KEY ("report_id") REFERENCES "drive_reports"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "drive_report_keys" ADD CONSTRAINT "drive_report_keys_report_id_drive_reports_id_fkey" FOREIGN KEY ("report_id") REFERENCES "drive_reports"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "drive_report_keys" ADD CONSTRAINT "drive_report_keys_operator_user_id_users_id_fkey" FOREIGN KEY ("operator_user_id") REFERENCES "users"("id") ON DELETE CASCADE;