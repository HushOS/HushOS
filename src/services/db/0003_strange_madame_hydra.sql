DO $$ BEGIN
 CREATE TYPE "directory_status" AS ENUM('normal', 'deleted', 'permanently_deleted');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "file_status" AS ENUM('upload_started', 'upload_failed', 'upload_cancelled', 'upload_finished', 'deleted', 'permanently_deleted', 'size_mismatch', 'malicious_upload', 'old_version');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "directory_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"materializedPath" text NOT NULL,
	"is_shared" boolean DEFAULT false,
	"directory_status" "directory_status" DEFAULT 'normal',
	"secret_key_bundle" jsonb NOT NULL,
	"metadata_bundle" jsonb NOT NULL,
	"workspace_id" uuid NOT NULL,
	"parent_directory_id" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "file_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"materializedPath" text NOT NULL,
	"is_shared" boolean,
	"encrypted_size" bigint NOT NULL,
	"file_status" "file_status" DEFAULT 'upload_started',
	"secret_key_bundle" jsonb NOT NULL,
	"metadata_bundle" jsonb NOT NULL,
	"s3_config" jsonb NOT NULL,
	"workspace_id" uuid NOT NULL,
	"parent_directory_id" uuid NOT NULL,
	"previous_version_id" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bigint" bigint DEFAULT 2147483648,
	"user_id" varchar NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "directory_nodes" ADD CONSTRAINT "directory_nodes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "directory_nodes" ADD CONSTRAINT "directory_nodes_parent_directory_id_directory_nodes_id_fk" FOREIGN KEY ("parent_directory_id") REFERENCES "directory_nodes"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "file_nodes" ADD CONSTRAINT "file_nodes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "file_nodes" ADD CONSTRAINT "file_nodes_parent_directory_id_directory_nodes_id_fk" FOREIGN KEY ("parent_directory_id") REFERENCES "directory_nodes"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "file_nodes" ADD CONSTRAINT "file_nodes_previous_version_id_file_nodes_id_fk" FOREIGN KEY ("previous_version_id") REFERENCES "file_nodes"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
