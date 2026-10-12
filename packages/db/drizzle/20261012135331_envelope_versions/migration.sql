-- Links made so far used the unlabelled derivation: version 1. New ones are version 2.
ALTER TABLE "drive_links" ADD COLUMN "kdf_version" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "drive_links" ALTER COLUMN "kdf_version" SET DEFAULT 2;--> statement-breakpoint
ALTER TABLE "drive_nodes" ADD COLUMN "envelope_suite" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_documents" ADD COLUMN "envelope_suite" smallint DEFAULT 1 NOT NULL;