-- Hand-edited (this header, the lock timeout, the two INSERTs, the order of the ALTERs and NOT
-- VALID). Stores and regions as tables (docs/company-storage-design.md 2.1, 11.1; its PR 1): two
-- new tables, "object_stores" and "storage_regions"; the environment's primary store and its
-- replica as rows with fixed ids that hold no address, bucket or key; one region, "default",
-- pointing at the first with the second as its backup; and "store_id" on "drive_objects",
-- "drive_uploads" and "drive_object_deletions", NOT NULL with the environment primary's id as a
-- constant default. Nothing is rewritten and nothing is scanned: a constant default is a catalog
-- change, every existing row reads as the environment's primary, and a container of the previous
-- release, which names no store when it inserts, writes that id too. The foreign keys on the three
-- existing tables and the new check on "drive_uploads" are added NOT VALID, so they bind every
-- row written from here on without reading the rows already there (all of which hold the default,
-- which exists); a later release validates them. "drive_uploads"."multipart_id" becomes nullable:
-- begin now commits the row first and writes the id once the store has started the upload.
-- ADD COLUMN and DROP NOT NULL take an ACCESS EXCLUSIVE lock on "drive_objects", "drive_uploads"
-- and "drive_object_deletions", in that order, held until drizzle's single transaction commits;
-- the check asks for the same lock and the foreign keys for a weaker one (SHARE ROW EXCLUSIVE,
-- there and on the new "object_stores"). Each statement waits at most five seconds for a lock and
-- fails, to be retried, rather than queue every Drive request behind this migration.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "object_stores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"group_id" uuid,
	"endpoint" text,
	"internal_endpoint" text,
	"signing_region" text,
	"bucket" text,
	"path_style" boolean,
	"origin" text,
	"key_hint" text,
	"seal" text,
	"secret_key_id" bytea,
	"secret_nonce" bytea,
	"secret_sealed" bytea,
	"status" text DEFAULT 'draft' NOT NULL,
	"draft_until" timestamp with time zone,
	"env_present" boolean,
	"tested_at" timestamp with time zone,
	"test_result" jsonb,
	"probed_at" timestamp with time zone,
	"probe_failures" integer DEFAULT 0 NOT NULL,
	"audit_pass_started_at" timestamp with time zone,
	"audit_pass_finished_at" timestamp with time zone,
	"stated_location" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "object_stores_source_valid" CHECK ("source" in ('environment', 'database')),
	CONSTRAINT "object_stores_kind_valid" CHECK ("kind" in ('region', 'backup', 'company', 'export')),
	CONSTRAINT "object_stores_status_valid" CHECK ("status" in ('draft', 'checking', 'ready', 'failing', 'retired')),
	CONSTRAINT "object_stores_seal_valid" CHECK ("seal" is null or ("seal" in ('symmetric', 'worker') and ("seal" = 'symmetric') = ("kind" in ('region', 'company')))),
	CONSTRAINT "object_stores_group_valid" CHECK (("kind" in ('company', 'export')) = ("group_id" is not null)),
	CONSTRAINT "object_stores_internal_endpoint_valid" CHECK ("internal_endpoint" is null or "kind" in ('region', 'backup')),
	CONSTRAINT "object_stores_environment_fixed" CHECK (("source" = 'environment') = ("id" in ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002')) and ("id" <> '00000000-0000-4000-8000-000000000001' or "kind" = 'region') and ("id" <> '00000000-0000-4000-8000-000000000002' or "kind" = 'backup')),
	CONSTRAINT "object_stores_environment_empty" CHECK ("source" <> 'environment' or ("endpoint" is null and "internal_endpoint" is null and "signing_region" is null and "bucket" is null and "path_style" is null and "origin" is null and "key_hint" is null and "seal" is null and "secret_key_id" is null and "secret_nonce" is null and "secret_sealed" is null and "draft_until" is null and "group_id" is null and "status" in ('ready', 'failing') and "env_present" is not null)),
	CONSTRAINT "object_stores_database_address" CHECK ("source" <> 'database' or ("endpoint" is not null and "signing_region" is not null and "bucket" is not null and "path_style" is not null and "env_present" is null)),
	CONSTRAINT "object_stores_values_valid" CHECK ("version" >= 1 and "probe_failures" >= 0 and ("key_hint" is null or char_length("key_hint") <= 4) and ("secret_key_id" is null or octet_length("secret_key_id") = 8))
);
--> statement-breakpoint
CREATE TABLE "storage_regions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"code" text NOT NULL UNIQUE,
	"label" text NOT NULL,
	"store_id" uuid NOT NULL,
	"backup_store_id" uuid,
	"backup_every" text DEFAULT '5m' NOT NULL,
	"backup_prune" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"offered" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_regions_code_valid" CHECK ("code" ~ '^[a-z][a-z0-9-]{0,31}$'),
	CONSTRAINT "storage_regions_label_valid" CHECK (char_length("label") between 1 and 80),
	CONSTRAINT "storage_regions_backup_every_valid" CHECK ("backup_every" in ('5m', 'hour', 'day')),
	CONSTRAINT "storage_regions_backup_distinct" CHECK ("backup_store_id" is null or "backup_store_id" <> "store_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "storage_regions_one_default" ON "storage_regions" ("is_default") WHERE is_default;--> statement-breakpoint
ALTER TABLE "storage_regions" ADD CONSTRAINT "storage_regions_store_id_object_stores_id_fkey" FOREIGN KEY ("store_id") REFERENCES "object_stores"("id");--> statement-breakpoint
ALTER TABLE "storage_regions" ADD CONSTRAINT "storage_regions_backup_store_id_object_stores_id_fkey" FOREIGN KEY ("backup_store_id") REFERENCES "object_stores"("id");--> statement-breakpoint
INSERT INTO "object_stores" ("id", "source", "kind", "status", "env_present") VALUES
	('00000000-0000-4000-8000-000000000001', 'environment', 'region', 'ready', true),
	('00000000-0000-4000-8000-000000000002', 'environment', 'backup', 'ready', false);--> statement-breakpoint
INSERT INTO "storage_regions" ("code", "label", "store_id", "backup_store_id", "backup_every", "backup_prune", "is_default", "offered") VALUES
	('default', 'Default', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '5m', true, true, true);--> statement-breakpoint
ALTER TABLE "drive_objects" ADD COLUMN "store_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "drive_objects" ADD CONSTRAINT "drive_objects_store_id_object_stores_id_fkey" FOREIGN KEY ("store_id") REFERENCES "object_stores"("id") NOT VALID;--> statement-breakpoint
ALTER TABLE "drive_uploads" ADD COLUMN "store_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "drive_uploads" ALTER COLUMN "multipart_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "drive_uploads" ADD CONSTRAINT "drive_uploads_store_id_object_stores_id_fkey" FOREIGN KEY ("store_id") REFERENCES "object_stores"("id") NOT VALID;--> statement-breakpoint
ALTER TABLE "drive_uploads" ADD CONSTRAINT "drive_uploads_multipart_started" CHECK ("multipart_id" is not null or "status" in ('open', 'aborted')) NOT VALID;--> statement-breakpoint
ALTER TABLE "drive_object_deletions" ADD COLUMN "store_id" uuid DEFAULT '00000000-0000-4000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE "drive_object_deletions" ADD CONSTRAINT "drive_object_deletions_store_id_object_stores_id_fkey" FOREIGN KEY ("store_id") REFERENCES "object_stores"("id") NOT VALID;
